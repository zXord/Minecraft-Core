const assert = require('node:assert/strict');
const crypto = require('node:crypto');
const fs = require('node:fs');
const fsp = require('node:fs/promises');
const os = require('node:os');
const path = require('node:path');
const test = require('node:test');
const AdmZip = require('adm-zip');

const {
  OperationJournal,
  createDirectoryMarker
} = require('../electron/services/modpack-lifecycle/operation-journal.cjs');
const {
  createRecoveryTargetEnvelope
} = require('../electron/services/modpack-lifecycle/recovery-target-envelope.cjs');
const {
  inspectServerDirectoryTree
} = require('../electron/services/modpack-lifecycle/server-directory-identity.cjs');
const {
  createExistingSiblingPaths
} = require('../electron/services/modpack-lifecycle/server-directory-transaction.cjs');
const {
  MANAGEMENT_CONTINUATION_ROOT_ENV,
  assertNoLifecycleProcesses,
  auditRecoveredManagementLifecycle,
  getPreservedManagementRoot,
  isPreservedManagementContinuationEnabled,
  loadPreservedRealManagementLifecycle
} = require('./e2e/fixtures/preserved-real-modrinth-management-harness.cjs');

test('terminal management process audit fails closed for root-bound Electron or Java only', () => {
  const root = path.join(os.tmpdir(), 'minecraft-core-real-modrinth-management-e2e-process-audit');
  assert.deepEqual(assertNoLifecycleProcesses(root, { processes: [
    { Name: 'java.exe', CommandLine: 'java -jar C:\\unrelated\\server.jar' },
    { Name: 'node.exe', CommandLine: `node ${root}\\script.js` }
  ] }), []);
  for (const name of ['java.exe', 'javaw.exe', 'electron.exe']) {
    assert.throws(() => assertNoLifecycleProcesses(root, {
      processes: [{ Name: name, CommandLine: `"${root}\\runtime"` }]
    }), /lifecycle-root Electron or Java process/iu);
  }
});

const noReparse = Object.freeze({ async isReparsePoint() { return false; } });
const SENTINEL_TEXT = 'unmanaged world data must survive\n';
const CURRENT_RUNTIME = Object.freeze({
  minecraftVersion: '1.20.1',
  loaderFamily: 'fabric',
  loaderVersion: '0.16.9',
  javaMajor: 17,
  os: 'win32',
  architecture: 'x64'
});
const INITIAL_RUNTIME = Object.freeze({ ...CURRENT_RUNTIME, loaderVersion: '0.15.10' });

function sha256Bytes(value) {
  return crypto.createHash('sha256').update(value).digest('hex');
}

function sha256File(filePath) {
  return sha256Bytes(fs.readFileSync(filePath));
}

function jsonWrite(filePath, value) {
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
  fs.writeFileSync(filePath, `${JSON.stringify(value, null, 2)}\n`, 'utf8');
}

const OPERATION_RECORD_KEYS = Object.freeze([
  'type', 'schemaVersion', 'sequence', 'jobId', 'operationKind', 'serverId', 'planFingerprint', 'phase', 'swapStep',
  'progress', 'cancellationRequested', 'createdAt', 'updatedAt', 'terminalAt', 'outcome', 'events', 'checksum'
]);

function operationChecksum(record) {
  const payload = Object.fromEntries(OPERATION_RECORD_KEYS
    .filter(key => key !== 'checksum')
    .map(key => [key, record[key]]));
  return sha256Bytes(JSON.stringify(payload));
}

function comparablePath(value) {
  const resolved = path.resolve(value);
  return process.platform === 'win32' ? resolved.toLocaleLowerCase('en-US') : resolved;
}

function enumerateTree(root, prefix = '') {
  const entries = [];
  function visit(directory, relativeParent) {
    const names = fs.readdirSync(directory).sort((left, right) => left.localeCompare(right, 'en-US'));
    for (const name of names) {
      const absolute = path.join(directory, name);
      const relative = relativeParent ? `${relativeParent}/${name}` : name;
      const archivePath = prefix ? `${prefix.replace(/\/$/u, '')}/${relative}` : relative;
      const stat = fs.lstatSync(absolute);
      if (stat.isDirectory()) {
        entries.push({ path: `${archivePath}/`, type: 'directory', size: 0, sha256: null });
        visit(absolute, relative);
      } else {
        entries.push({ path: archivePath, type: 'file', size: stat.size, sha256: sha256File(absolute) });
      }
    }
  }
  visit(root, '');
  return entries;
}

function scopeForEntries(entries) {
  const sorted = [...entries].sort((left, right) => left.path.localeCompare(right.path, 'en-US'));
  const files = sorted.filter(entry => entry.type === 'file');
  return {
    schemaVersion: 1,
    entries: sorted,
    totalBytes: files.reduce((sum, entry) => sum + entry.size, 0),
    fileCount: files.length,
    scopeSha256: sha256Bytes(JSON.stringify(sorted))
  };
}

function writeExactFixtureArchive(archivePath, {
  fileCount,
  directoryCount,
  requiredFiles = {}
}) {
  assert.ok(Object.keys(requiredFiles).length <= fileCount);
  const archive = new AdmZip();
  const entries = [];
  const requiredDirectories = [
    '.minecraft-core-state/',
    '.minecraft-core-state/manifests/'
  ];
  assert.ok(requiredDirectories.length <= directoryCount);
  for (const name of requiredDirectories) {
    archive.addFile(name, Buffer.alloc(0));
    entries.push({ path: name, type: 'directory', size: 0, sha256: null });
  }
  for (let index = requiredDirectories.length; index < directoryCount; index += 1) {
    const name = `fixture-directory-${String(index).padStart(3, '0')}/`;
    archive.addFile(name, Buffer.alloc(0));
    entries.push({ path: name, type: 'directory', size: 0, sha256: null });
  }
  for (const [name, value] of Object.entries(requiredFiles)) {
    const bytes = Buffer.isBuffer(value) ? value : Buffer.from(value);
    archive.addFile(name, bytes);
    entries.push({ path: name, type: 'file', size: bytes.length, sha256: sha256Bytes(bytes) });
  }
  for (let index = Object.keys(requiredFiles).length; index < fileCount; index += 1) {
    const name = `fixture-file-${String(index).padStart(3, '0')}.bin`;
    const bytes = Buffer.from(`fixture archive payload ${index}\n`);
    archive.addFile(name, bytes);
    entries.push({ path: name, type: 'file', size: bytes.length, sha256: sha256Bytes(bytes) });
  }
  archive.writeZip(archivePath);
  return scopeForEntries(entries);
}

function durableJsonFixture() {
  return {
    readFileBounded(filePath) { return fs.readFileSync(filePath); },
    async readFileBoundedAsync(filePath) { return fsp.readFile(filePath); },
    writeJsonAtomic(filePath, value, { expectedTargetSha256 = null } = {}) {
      if (expectedTargetSha256 !== null) {
        assert.equal(sha256File(filePath), expectedTargetSha256);
      }
      jsonWrite(filePath, value);
    },
    async writeJsonAtomicAsync(filePath, value, { expectedTargetSha256 = null } = {}) {
      if (expectedTargetSha256 !== null) {
        assert.equal(sha256Bytes(await fsp.readFile(filePath)), expectedTargetSha256);
      }
      await fsp.writeFile(filePath, `${JSON.stringify(value, null, 2)}\n`, 'utf8');
    }
  };
}

async function createManagementFixture() {
  const root = await fsp.mkdtemp(path.join(os.tmpdir(), 'minecraft-core-real-modrinth-management-e2e-'));
  const serverPath = path.join(root, 'server');
  const userDataPath = path.join(root, 'user-data');
  const clientPath = path.join(root, 'client');
  const evidencePath = path.join(root, 'evidence');
  const instanceId = 'server-management-disposable';
  const jobId = 'job-management-recovery';
  const updateJobId = 'job-management-update';
  const selectedRestoreId = 'restore-management-selected';
  const safetyRestoreId = 'restore-management-safety';
  const currentManifestId = 'installation-management-current';
  const initialManifestId = 'installation-management-initial';
  const sentinelPath = path.join(serverPath, 'world', 'minecraft-core-real-e2e.keep');
  const managedModPath = path.join(serverPath, 'mods', 'managed-current.jar');
  const backupsPath = path.join(serverPath, 'backups');
  const stateRoot = path.join(serverPath, '.minecraft-core-state');
  await Promise.all([
    fsp.mkdir(path.dirname(sentinelPath), { recursive: true }),
    fsp.mkdir(path.dirname(managedModPath), { recursive: true }),
    fsp.mkdir(path.join(stateRoot, 'manifests'), { recursive: true }),
    fsp.mkdir(path.join(stateRoot, 'history'), { recursive: true }),
    fsp.mkdir(backupsPath, { recursive: true }),
    fsp.mkdir(path.join(userDataPath, 'config'), { recursive: true }),
    fsp.mkdir(path.join(userDataPath, 'modpack-lifecycle', 'active'), { recursive: true }),
    fsp.mkdir(path.join(userDataPath, 'modpack-lifecycle', 'operations'), { recursive: true }),
    fsp.mkdir(clientPath),
    fsp.mkdir(evidencePath)
  ]);
  await Promise.all([
    fsp.writeFile(path.join(root, 'real-lifecycle-identity.json'), JSON.stringify({
      provider: 'modrinth',
      scenario: 'management-lifecycle'
    }), 'utf8'),
    fsp.writeFile(sentinelPath, SENTINEL_TEXT, 'utf8'),
    fsp.writeFile(managedModPath, 'current managed mod', 'utf8')
  ]);

  const currentState = {
    schemaVersion: 1,
    modpackManaged: true,
    source: {
      provider: 'modrinth',
      projectId: 'ca0m6gMz',
      versionId: 'zH4ppiGM'
    },
    runtime: CURRENT_RUNTIME,
    selectedOptionalFiles: [],
    installedAt: '2026-08-28T18:00:00.000Z',
    contentRevision: 3,
    manifestId: currentManifestId
  };
  const currentManifest = {
    schemaVersion: 1,
    installationId: currentManifestId,
    entries: [{
      path: 'mods/managed-current.jar',
      pathKey: 'mods/managed-current.jar',
      origin: 'pack',
      managementPolicy: 'replaceable-managed',
      role: 'mod',
      installedHash: sha256File(managedModPath),
      size: String(fs.statSync(managedModPath).size),
      priorBaseline: null
    }, {
      path: 'world/minecraft-core-real-e2e.keep',
      pathKey: 'world/minecraft-core-real-e2e.keep',
      origin: 'user',
      managementPolicy: 'protected',
      role: 'world',
      installedHash: sha256File(sentinelPath),
      size: String(fs.statSync(sentinelPath).size),
      priorBaseline: null
    }]
  };
  jsonWrite(path.join(stateRoot, 'modpack.json'), currentState);
  jsonWrite(path.join(stateRoot, 'manifests', `${currentManifestId}.json`), currentManifest);

  const paths = createExistingSiblingPaths(serverPath, jobId);
  const candidatePath = paths.candidatePath;
  const operationWorkspace = path.join(candidatePath, '.minecraft-core-state', 'operations', jobId);
  const selectedRestorePath = path.join(operationWorkspace, 'selected-restore');
  const candidateFabricPath = path.join(candidatePath, '.fabric');
  await Promise.all([
    fsp.mkdir(path.join(candidateFabricPath, 'processedMods'), { recursive: true }),
    fsp.mkdir(path.join(selectedRestorePath, '.minecraft-core-state', 'manifests'), { recursive: true }),
    fsp.mkdir(path.join(selectedRestorePath, 'config'), { recursive: true }),
    fsp.mkdir(path.join(selectedRestorePath, 'mods'), { recursive: true }),
    fsp.mkdir(path.join(selectedRestorePath, 'world'), { recursive: true })
  ]);
  await Promise.all([
    fsp.writeFile(path.join(candidateFabricPath, 'processedMods', 'runtime.jar'), 'initial runtime cache', 'utf8'),
    fsp.writeFile(path.join(selectedRestorePath, 'config', 'managed-initial.properties'), 'managed=true\n', 'utf8'),
    fsp.writeFile(path.join(selectedRestorePath, 'mods', 'managed-initial.jar'), 'initial managed mod', 'utf8'),
    fsp.writeFile(path.join(selectedRestorePath, 'world', 'minecraft-core-real-e2e.keep'), SENTINEL_TEXT, 'utf8')
  ]);
  const initialState = {
    ...currentState,
    source: { ...currentState.source, versionId: 'oQ6gSIoF' },
    runtime: INITIAL_RUNTIME,
    contentRevision: 2,
    manifestId: initialManifestId
  };
  const initialModPath = path.join(selectedRestorePath, 'mods', 'managed-initial.jar');
  const initialManagedLivePath = path.join(serverPath, 'mods', 'managed-initial.jar');
  const secondaryInitialManagedPath = path.join(selectedRestorePath, 'config', 'managed-initial.properties');
  const secondaryInitialManagedLivePath = path.join(serverPath, 'config', 'managed-initial.properties');
  const initialManifest = {
    schemaVersion: 1,
    installationId: initialManifestId,
    entries: [{
      path: 'mods/managed-initial.jar',
      pathKey: 'mods/managed-initial.jar',
      origin: 'pack',
      managementPolicy: 'replaceable-managed',
      role: 'mod',
      installedHash: sha256File(initialModPath),
      size: String(fs.statSync(initialModPath).size),
      priorBaseline: null
    }, {
      path: 'config/managed-initial.properties',
      pathKey: 'config/managed-initial.properties',
      origin: 'pack',
      managementPolicy: 'replaceable-managed',
      role: 'config',
      installedHash: sha256File(secondaryInitialManagedPath),
      size: String(fs.statSync(secondaryInitialManagedPath).size),
      priorBaseline: null
    }, {
      path: 'world/minecraft-core-real-e2e.keep',
      pathKey: 'world/minecraft-core-real-e2e.keep',
      origin: 'user',
      managementPolicy: 'protected',
      role: 'world',
      installedHash: sha256File(path.join(selectedRestorePath, 'world', 'minecraft-core-real-e2e.keep')),
      size: String(fs.statSync(path.join(selectedRestorePath, 'world', 'minecraft-core-real-e2e.keep')).size),
      priorBaseline: null
    }]
  };
  jsonWrite(path.join(selectedRestorePath, '.minecraft-core-state', 'modpack.json'), initialState);
  jsonWrite(path.join(selectedRestorePath, '.minecraft-core-state', 'manifests', `${initialManifestId}.json`), initialManifest);

  const selectedScope = scopeForEntries([
    { path: '.fabric/', type: 'directory', size: 0, sha256: null },
    ...enumerateTree(candidateFabricPath, '.fabric/'),
    ...enumerateTree(selectedRestorePath)
  ]);
  const selectedArchiveName = 'restore-point-management-selected.zip';
  const selectedArchivePath = path.join(backupsPath, selectedArchiveName);
  await fsp.writeFile(selectedArchivePath, 'selected verified archive', 'utf8');
  const selectedMetadata = {
    schemaVersion: 1,
    kind: 'minecraft-core-lifecycle-restore-point',
    id: selectedRestoreId,
    name: selectedArchiveName,
    sha256: sha256File(selectedArchivePath),
    size: fs.statSync(selectedArchivePath).size,
    scopeSha256: selectedScope.scopeSha256,
    scope: selectedScope,
    sourceRevision: 2,
    sourceRuntime: INITIAL_RUNTIME,
    operationId: updateJobId,
    createdAt: '2026-08-28T18:30:00.000Z',
    pins: [updateJobId]
  };
  jsonWrite(path.join(backupsPath, selectedArchiveName.replace(/\.zip$/u, '.json')), selectedMetadata);

  const emptyScope = scopeForEntries([]);
  const safetyArchiveName = 'restore-point-management-safety.zip';
  const safetyArchivePath = path.join(backupsPath, safetyArchiveName);
  await fsp.writeFile(safetyArchivePath, 'safety verified archive', 'utf8');
  const safetyMetadata = {
    schemaVersion: 1,
    kind: 'minecraft-core-lifecycle-restore-point',
    id: safetyRestoreId,
    name: safetyArchiveName,
    sha256: sha256File(safetyArchivePath),
    size: fs.statSync(safetyArchivePath).size,
    scopeSha256: emptyScope.scopeSha256,
    scope: emptyScope,
    sourceRevision: 3,
    sourceRuntime: CURRENT_RUNTIME,
    operationId: jobId,
    createdAt: '2026-08-28T19:00:00.000Z',
    pins: [jobId]
  };
  const safetyMetadataPath = path.join(backupsPath, safetyArchiveName.replace(/\.zip$/u, '.json'));
  jsonWrite(safetyMetadataPath, safetyMetadata);

  const upgradeHistory = {
    schemaVersion: 1,
    operationId: updateJobId,
    sequence: 3,
    kind: 'upgrade',
    outcome: 'completed',
    timestamp: '2026-08-28T18:45:00.000Z',
    sourceRevision: 2,
    targetRevision: 3,
    restorePointId: selectedRestoreId,
    restorePointSha256: selectedMetadata.sha256,
    restorePointTotalBytes: String(selectedScope.totalBytes),
    sourceRuntime: INITIAL_RUNTIME,
    targetRuntime: CURRENT_RUNTIME
  };
  jsonWrite(path.join(stateRoot, 'history', `${updateJobId}.json`), upgradeHistory);
  jsonWrite(path.join(userDataPath, 'config', 'minecraft-core-config.json'), {
    lastServerPath: null,
    instances: [{ id: instanceId, name: 'server', type: 'server', path: serverPath }]
  });

  const marker = createDirectoryMarker({
    jobId,
    operationKind: 'rollback',
    stableInstanceId: instanceId,
    createdAt: '2026-08-28T19:05:00.000Z'
  });
  const markerPath = path.join(operationWorkspace, 'directory-marker.json');
  jsonWrite(markerPath, marker);
  const [targetInspection, candidateInspection] = await Promise.all([
    inspectServerDirectoryTree(serverPath, { reparseInspector: noReparse }),
    inspectServerDirectoryTree(candidatePath, { reparseInspector: noReparse })
  ]);
  const journalPath = path.join(operationWorkspace, 'journal.json');
  const journal = new OperationJournal({
    durableFs: durableJsonFixture(),
    fsApi: fs,
    clock: () => new Date('2026-08-28T19:06:00.000Z')
  });
  await journal.create(journalPath, {
    jobId,
    operationKind: 'rollback',
    stableInstanceId: instanceId,
    targetPath: serverPath,
    candidateIdentity: candidateInspection.directoryIdentity,
    markerSha256: marker.checksum
  });
  await journal.transition(journalPath, {
    expectedPhase: 'staging',
    nextPhase: 'validating-candidate',
    patch: { targetIdentity: targetInspection.directoryIdentity }
  });

  const active = {
    schemaVersion: 2,
    sequence: 12,
    jobId,
    operationKind: 'rollback',
    target: { kind: 'existing', stableServerId: instanceId, path: serverPath },
    candidatePath: paths.candidatePath,
    rollbackPath: paths.rollbackPath,
    failedPath: paths.failedPath,
    restorePoint: { id: safetyRestoreId, sha256: safetyMetadata.sha256 },
    restoreCreation: null,
    journalPath,
    priorRuntime: { running: false, autoRestart: false },
    phase: 'validating-candidate',
    swapStep: 'none',
    directoryIdentities: {
      target: targetInspection.directoryIdentity,
      candidate: candidateInspection.directoryIdentity,
      rollback: null,
      failed: null
    },
    createdAt: '2026-08-28T19:04:00.000Z',
    updatedAt: '2026-08-28T19:07:00.000Z',
    outcome: {
      live: { fingerprint: targetInspection.fingerprint },
      runtime: { maxRam: 4, port: 25565, source: CURRENT_RUNTIME, target: INITIAL_RUNTIME },
      runtimePolicy: { targetRunning: false, targetAutoRestart: false, targetInactive: false },
      target: { name: 'server' },
      revision: { source: 3, target: 4 }
    }
  };
  const activePath = path.join(userDataPath, 'modpack-lifecycle', 'active', `${jobId}.json`);
  jsonWrite(activePath, active);
  jsonWrite(
    path.join(userDataPath, 'modpack-lifecycle', 'active', `${jobId}.target.json`),
    createRecoveryTargetEnvelope(active)
  );
  const originalFailedJob = {
    type: 'minecraft-core-modpack-job',
    schemaVersion: 1,
    sequence: 2,
    jobId,
    operationKind: 'rollback-restore-point',
    serverId: instanceId,
    planFingerprint: '3'.repeat(64),
    phase: 'failed',
    swapStep: null,
    progress: { percent: 43, message: 'Restoring the selected verified server snapshot', currentItem: null },
    cancellationRequested: false,
    createdAt: '2026-08-28T19:04:00.000Z',
    updatedAt: '2026-08-28T19:20:00.000Z',
    terminalAt: '2026-08-28T19:20:00.000Z',
    outcome: {
      status: 'failed',
      message: 'The operation failed before the server changed',
      errorCode: 'COMMIT_FAILED',
      cleanupPending: false,
      actions: []
    },
    events: [],
    checksum: ''
  };
  originalFailedJob.checksum = operationChecksum(originalFailedJob);
  jsonWrite(path.join(userDataPath, 'modpack-lifecycle', 'operations', `${jobId}.json`), originalFailedJob);

  return {
    root,
    serverPath,
    userDataPath,
    candidatePath,
    instanceId,
    jobId,
    selectedRestoreId,
    managedModPath,
    initialManagedLivePath,
    secondaryInitialManagedLivePath,
    initialState,
    initialManifest,
    sentinelPath,
    activePath,
    safetyMetadataPath
  };
}

async function removeFixture(root) {
  const resolved = path.resolve(root);
  assert.equal(comparablePath(path.dirname(resolved)), comparablePath(os.tmpdir()));
  assert.match(path.basename(resolved), /^minecraft-core-real-modrinth-management-e2e-[A-Za-z0-9_-]+$/u);
  await fsp.rm(resolved, { recursive: true, force: true, maxRetries: 3 });
}

async function markManagementFixtureCompleted(fixture) {
  await fsp.rm(fixture.candidatePath, { recursive: true, force: true });
  for (const name of await fsp.readdir(path.dirname(fixture.activePath))) {
    await fsp.rm(path.join(path.dirname(fixture.activePath), name), { force: true });
  }
  const statePath = path.join(fixture.serverPath, '.minecraft-core-state', 'modpack.json');
  const state = JSON.parse(await fsp.readFile(statePath, 'utf8'));
  await fsp.rm(fixture.managedModPath);
  jsonWrite(statePath, {
    ...state,
    modpackManaged: false,
    lifecycleMode: 'uninstalled',
    source: { ...state.source, versionId: 'oQ6gSIoF' },
    runtime: null,
    contentRevision: 7,
    manifestId: null,
    provenance: { classification: 'uninstalled', inspectionFingerprint: '0'.repeat(64) }
  });
  const historyPath = path.join(fixture.serverPath, '.minecraft-core-state', 'history');
  for (const [sequence, kind] of [[4, 'rollback'], [5, 'detach'], [6, 'rollback'], [7, 'uninstall']]) {
    jsonWrite(path.join(historyPath, `job-completed-${sequence}.json`), {
      schemaVersion: 1,
      operationId: `job-completed-${sequence}`,
      sequence,
      kind,
      outcome: 'completed',
      timestamp: `2026-08-28T20:0${sequence}:00.000Z`,
      sourceRevision: sequence - 1,
      targetRevision: sequence
    });
  }
}

async function markManagementFixturePostRecoveryPlanStale(fixture) {
  const lifecycleRoot = path.join(fixture.userDataPath, 'modpack-lifecycle');
  const activeRoot = path.join(lifecycleRoot, 'active');
  const historyRoot = path.join(lifecycleRoot, 'history');
  const workspacesRoot = path.join(lifecycleRoot, 'workspaces');
  const rawRecord = JSON.parse(await fsp.readFile(fixture.activePath, 'utf8'));
  const candidateInspection = await inspectServerDirectoryTree(fixture.candidatePath, { reparseInspector: noReparse });
  const terminalRecord = {
    ...rawRecord,
    sequence: rawRecord.sequence + 2,
    phase: 'failed',
    directoryIdentities: {
      ...rawRecord.directoryIdentities,
      rollback: rawRecord.directoryIdentities.target
    },
    updatedAt: '2026-08-28T20:14:18.477Z',
    outcome: {
      ...rawRecord.outcome,
      candidateCleanup: {
        deletionAuthorized: true,
        slot: 'candidate',
        action: 'pre-swap-restored',
        directoryIdentity: rawRecord.directoryIdentities.candidate,
        fingerprint: candidateInspection.fingerprint,
        ownershipMode: 'recorded-identity'
      },
      recovery: { action: 'pre-swap-restored', operationId: fixture.jobId }
    }
  };
  await fsp.mkdir(historyRoot, { recursive: true });
  await fsp.mkdir(workspacesRoot, { recursive: true });
  jsonWrite(path.join(historyRoot, `${fixture.jobId}.json`), terminalRecord);
  jsonWrite(path.join(historyRoot, `${fixture.jobId}.target.json`), createRecoveryTargetEnvelope(terminalRecord));
  for (const name of await fsp.readdir(activeRoot)) await fsp.rm(path.join(activeRoot, name), { force: true });
  await fsp.rm(fixture.candidatePath, { recursive: true, force: true });

  const configPath = path.join(fixture.userDataPath, 'config', 'minecraft-core-config.json');
  const config = JSON.parse(await fsp.readFile(configPath, 'utf8'));
  jsonWrite(configPath, { ...config, lastServerPath: fixture.serverPath });
  jsonWrite(path.join(fixture.serverPath, '.minecraft-core.json'), { contentRevision: 4 });

  const failedRollbackJobId = 'job-management-post-recovery-plan-stale';
  const failedJob = {
    type: 'minecraft-core-modpack-job',
    schemaVersion: 1,
    sequence: 2,
    jobId: failedRollbackJobId,
    operationKind: 'rollback-restore-point',
    serverId: fixture.instanceId,
    planFingerprint: '4'.repeat(64),
    phase: 'failed',
    swapStep: null,
    progress: { percent: 5, message: 'Revalidating the reviewed plan', currentItem: null },
    cancellationRequested: false,
    createdAt: '2026-08-28T20:15:12.945Z',
    updatedAt: '2026-08-28T20:15:19.537Z',
    terminalAt: '2026-08-28T20:15:19.537Z',
    outcome: {
      status: 'failed',
      message: 'The operation failed before the server changed',
      errorCode: 'PLAN_STALE',
      cleanupPending: false,
      actions: [
        { actionId: 'change-selection', opaqueRef: `oa:cs:${failedRollbackJobId}` },
        { actionId: 'open-details', opaqueRef: `oa:od:${failedRollbackJobId}` }
      ]
    },
    events: [],
    checksum: ''
  };
  failedJob.checksum = operationChecksum(failedJob);
  const failedRollbackJobPath = path.join(lifecycleRoot, 'operations', `${failedRollbackJobId}.json`);
  jsonWrite(failedRollbackJobPath, failedJob);
  return {
    ...fixture,
    failedRollbackJobId,
    failedRollbackJobPath,
    recoveredRecordPath: path.join(historyRoot, `${fixture.jobId}.json`),
    coordinatorConfigPath: path.join(fixture.serverPath, '.minecraft-core.json'),
    workspacesRoot
  };
}

async function markManagementFixturePostRecoveryActive(fixture) {
  const postRecovery = await markManagementFixturePostRecoveryPlanStale(fixture);
  const lifecycleRoot = path.join(postRecovery.userDataPath, 'modpack-lifecycle');
  const jobId = `op2-${'c'.repeat(32)}`;
  const safetyRestoreId = 'restore-management-post-recovery-active-safety';
  const paths = createExistingSiblingPaths(postRecovery.serverPath, jobId);
  const candidatePath = paths.candidatePath;
  const operationWorkspace = path.join(candidatePath, '.minecraft-core-state', 'operations', jobId);
  const selectedRestorePath = path.join(operationWorkspace, 'selected-restore');
  const candidateFabricPath = path.join(candidatePath, '.fabric');
  await Promise.all([
    fsp.mkdir(path.join(candidateFabricPath, 'processedMods'), { recursive: true }),
    fsp.mkdir(path.join(candidatePath, '.minecraft-core-state', 'history'), { recursive: true }),
    fsp.mkdir(path.join(candidatePath, '.minecraft-core-state', 'manifests'), { recursive: true }),
    fsp.mkdir(path.join(selectedRestorePath, '.minecraft-core-state', 'manifests'), { recursive: true }),
    fsp.mkdir(path.join(selectedRestorePath, 'config'), { recursive: true }),
    fsp.mkdir(path.join(selectedRestorePath, 'mods'), { recursive: true }),
    fsp.mkdir(path.join(selectedRestorePath, 'world'), { recursive: true })
  ]);
  await Promise.all([
    ...Array.from({ length: 77 }, (_, index) => fsp.writeFile(
      path.join(candidateFabricPath, 'processedMods', `runtime-${String(index).padStart(3, '0')}.jar`),
      `initial runtime cache ${index}\n`,
      'utf8'
    )),
    fsp.writeFile(path.join(selectedRestorePath, 'config', 'managed-initial.properties'), 'managed=true\n', 'utf8'),
    fsp.writeFile(path.join(selectedRestorePath, 'mods', 'managed-initial.jar'), 'initial managed mod', 'utf8'),
    fsp.writeFile(path.join(selectedRestorePath, 'world', 'minecraft-core-real-e2e.keep'), SENTINEL_TEXT, 'utf8')
  ]);
  jsonWrite(path.join(selectedRestorePath, '.minecraft-core-state', 'modpack.json'), postRecovery.initialState);
  jsonWrite(
    path.join(selectedRestorePath, '.minecraft-core-state', 'manifests', `${postRecovery.initialManifest.installationId}.json`),
    postRecovery.initialManifest
  );

  const selectedScope = scopeForEntries([
    { path: '.fabric/', type: 'directory', size: 0, sha256: null },
    ...enumerateTree(candidateFabricPath, '.fabric/'),
    ...enumerateTree(selectedRestorePath)
  ]);
  const backupsPath = path.join(postRecovery.serverPath, 'backups');
  const selectedMetadataPath = (await Promise.all((await fsp.readdir(backupsPath))
    .filter(name => name.endsWith('.json'))
    .map(async name => ({
      path: path.join(backupsPath, name),
      value: JSON.parse(await fsp.readFile(path.join(backupsPath, name), 'utf8'))
    })))).find(item => item.value.id === postRecovery.selectedRestoreId)?.path;
  assert.equal(typeof selectedMetadataPath, 'string');
  const selectedMetadata = JSON.parse(await fsp.readFile(selectedMetadataPath, 'utf8'));
  jsonWrite(selectedMetadataPath, {
    ...selectedMetadata,
    scopeSha256: selectedScope.scopeSha256,
    scope: selectedScope
  });
  const upgradeHistoryPath = path.join(
    postRecovery.serverPath,
    '.minecraft-core-state',
    'history',
    'job-management-update.json'
  );
  const upgradeHistory = JSON.parse(await fsp.readFile(upgradeHistoryPath, 'utf8'));
  jsonWrite(upgradeHistoryPath, { ...upgradeHistory, restorePointTotalBytes: String(selectedScope.totalBytes) });

  const emptyScope = scopeForEntries([]);
  const safetyArchiveName = 'restore-point-management-post-recovery-active-safety.zip';
  const safetyArchivePath = path.join(backupsPath, safetyArchiveName);
  await fsp.writeFile(safetyArchivePath, 'post-recovery active safety verified archive', 'utf8');
  const safetyMetadata = {
    schemaVersion: 1,
    kind: 'minecraft-core-lifecycle-restore-point',
    id: safetyRestoreId,
    name: safetyArchiveName,
    sha256: sha256File(safetyArchivePath),
    size: fs.statSync(safetyArchivePath).size,
    scopeSha256: emptyScope.scopeSha256,
    scope: emptyScope,
    sourceRevision: 4,
    sourceRuntime: CURRENT_RUNTIME,
    operationId: jobId,
    createdAt: '2026-08-28T20:36:28.000Z',
    pins: [jobId]
  };
  const safetyMetadataPath = path.join(backupsPath, safetyArchiveName.replace(/\.zip$/u, '.json'));
  jsonWrite(safetyMetadataPath, safetyMetadata);

  const marker = createDirectoryMarker({
    jobId,
    operationKind: 'rollback',
    stableInstanceId: postRecovery.instanceId,
    createdAt: '2026-08-28T20:36:29.122Z'
  });
  const markerPath = path.join(operationWorkspace, 'directory-marker.json');
  jsonWrite(markerPath, marker);
  const [targetInspection, candidateInspection] = await Promise.all([
    inspectServerDirectoryTree(postRecovery.serverPath, { reparseInspector: noReparse }),
    inspectServerDirectoryTree(candidatePath, { reparseInspector: noReparse })
  ]);
  const journalPath = path.join(operationWorkspace, 'journal.json');
  const journal = new OperationJournal({
    durableFs: durableJsonFixture(),
    fsApi: fs,
    clock: () => new Date('2026-08-28T20:37:47.436Z')
  });
  await journal.create(journalPath, {
    jobId,
    operationKind: 'rollback',
    stableInstanceId: postRecovery.instanceId,
    targetPath: postRecovery.serverPath,
    candidateIdentity: candidateInspection.directoryIdentity,
    markerSha256: marker.checksum
  });
  await journal.transition(journalPath, {
    expectedPhase: 'staging',
    nextPhase: 'validating-candidate',
    patch: { targetIdentity: targetInspection.directoryIdentity }
  });

  const active = {
    schemaVersion: 2,
    sequence: 12,
    jobId,
    operationKind: 'rollback',
    target: { kind: 'existing', stableServerId: postRecovery.instanceId, path: postRecovery.serverPath },
    candidatePath: paths.candidatePath,
    rollbackPath: paths.rollbackPath,
    failedPath: paths.failedPath,
    restorePoint: { id: safetyRestoreId, sha256: safetyMetadata.sha256 },
    restoreCreation: null,
    journalPath,
    priorRuntime: { running: false, autoRestart: false },
    phase: 'validating-candidate',
    swapStep: 'none',
    directoryIdentities: {
      target: targetInspection.directoryIdentity,
      candidate: candidateInspection.directoryIdentity,
      rollback: null,
      failed: null
    },
    createdAt: '2026-08-28T20:36:29.122Z',
    updatedAt: '2026-08-28T20:37:47.436Z',
    outcome: {
      live: { fingerprint: targetInspection.fingerprint },
      runtime: { maxRam: 4, port: 25565, source: CURRENT_RUNTIME, target: INITIAL_RUNTIME },
      runtimePolicy: { targetRunning: false, targetAutoRestart: false, targetInactive: false },
      target: { name: 'server' },
      revision: { source: 3, target: 5 }
    }
  };
  const activePath = path.join(lifecycleRoot, 'active', `${jobId}.json`);
  jsonWrite(activePath, active);
  jsonWrite(path.join(lifecycleRoot, 'active', `${jobId}.target.json`), createRecoveryTargetEnvelope(active));

  const failedJob = {
    type: 'minecraft-core-modpack-job',
    schemaVersion: 1,
    sequence: 9,
    jobId,
    operationKind: 'rollback-restore-point',
    serverId: postRecovery.instanceId,
    planFingerprint: '5'.repeat(64),
    phase: 'failed',
    swapStep: null,
    progress: { percent: 43, message: 'Restoring the selected verified server snapshot', currentItem: null },
    cancellationRequested: false,
    createdAt: '2026-08-28T20:36:22.903Z',
    updatedAt: '2026-08-28T20:38:42.306Z',
    terminalAt: '2026-08-28T20:38:42.306Z',
    outcome: {
      status: 'failed',
      message: 'The operation failed before the server changed',
      errorCode: 'COMMIT_FAILED',
      cleanupPending: false,
      actions: [
        { actionId: 'change-selection', opaqueRef: `oa:cs:${jobId}` },
        { actionId: 'open-details', opaqueRef: `oa:od:${jobId}` }
      ]
    },
    events: [],
    checksum: ''
  };
  failedJob.checksum = operationChecksum(failedJob);
  const publicJobPath = path.join(lifecycleRoot, 'operations', `${jobId}.json`);
  jsonWrite(publicJobPath, failedJob);
  return {
    ...postRecovery,
    recoveredJobId: postRecovery.jobId,
    jobId,
    candidatePath,
    activePath,
    publicJobPath,
    safetyMetadataPath,
    movedFabricFileCount: 77
  };
}

async function terminalizeFixtureActiveRollback(fixture, updatedAt) {
  const lifecycleRoot = path.join(fixture.userDataPath, 'modpack-lifecycle');
  const historyRoot = path.join(lifecycleRoot, 'history');
  const rawRecord = JSON.parse(await fsp.readFile(fixture.activePath, 'utf8'));
  const candidateInspection = await inspectServerDirectoryTree(fixture.candidatePath, { reparseInspector: noReparse });
  const terminalRecord = {
    ...rawRecord,
    sequence: rawRecord.sequence + 2,
    phase: 'failed',
    directoryIdentities: {
      ...rawRecord.directoryIdentities,
      rollback: rawRecord.directoryIdentities.target
    },
    updatedAt,
    outcome: {
      ...rawRecord.outcome,
      candidateCleanup: {
        deletionAuthorized: true,
        slot: 'candidate',
        action: 'pre-swap-restored',
        directoryIdentity: rawRecord.directoryIdentities.candidate,
        fingerprint: candidateInspection.fingerprint,
        ownershipMode: 'recorded-identity'
      },
      recovery: { action: 'pre-swap-restored', operationId: rawRecord.jobId }
    }
  };
  jsonWrite(path.join(historyRoot, `${rawRecord.jobId}.json`), terminalRecord);
  jsonWrite(path.join(historyRoot, `${rawRecord.jobId}.target.json`), createRecoveryTargetEnvelope(terminalRecord));
  for (const name of await fsp.readdir(path.join(lifecycleRoot, 'active'))) {
    await fsp.rm(path.join(lifecycleRoot, 'active', name), { force: true });
  }
  await fsp.rm(fixture.candidatePath, { recursive: true, force: true });
  return terminalRecord;
}

async function markManagementFixturePostRecoveryTerminalLineage(fixture) {
  const firstTargetFive = await markManagementFixturePostRecoveryActive(fixture);
  const originalPublicPath = path.join(
    firstTargetFive.userDataPath,
    'modpack-lifecycle',
    'operations',
    `${firstTargetFive.recoveredJobId}.json`
  );
  const originalPublic = JSON.parse(await fsp.readFile(originalPublicPath, 'utf8'));
  originalPublic.outcome.actions = [
    { actionId: 'change-selection', opaqueRef: `oa:cs:${firstTargetFive.recoveredJobId}` },
    { actionId: 'open-details', opaqueRef: `oa:od:${firstTargetFive.recoveredJobId}` }
  ];
  originalPublic.checksum = operationChecksum(originalPublic);
  jsonWrite(originalPublicPath, originalPublic);
  await terminalizeFixtureActiveRollback(firstTargetFive, '2026-08-28T20:57:17.053Z');

  const lifecycleRoot = path.join(firstTargetFive.userDataPath, 'modpack-lifecycle');
  const jobId = 'job-management-post-recovery-terminal';
  const safetyRestoreId = 'restore-management-post-recovery-terminal-safety';
  const paths = createExistingSiblingPaths(firstTargetFive.serverPath, jobId);
  await fsp.mkdir(paths.candidatePath, { recursive: true });
  await fsp.writeFile(path.join(paths.candidatePath, 'candidate-probe.txt'), 'terminal recovery candidate\n', 'utf8');

  const backupsPath = path.join(firstTargetFive.serverPath, 'backups');
  const emptyScope = scopeForEntries([]);
  const safetyArchiveName = 'restore-point-management-post-recovery-terminal-safety.zip';
  const safetyArchivePath = path.join(backupsPath, safetyArchiveName);
  await fsp.writeFile(safetyArchivePath, 'post-recovery terminal safety verified archive', 'utf8');
  const safetyMetadata = {
    schemaVersion: 1,
    kind: 'minecraft-core-lifecycle-restore-point',
    id: safetyRestoreId,
    name: safetyArchiveName,
    sha256: sha256File(safetyArchivePath),
    size: fs.statSync(safetyArchivePath).size,
    scopeSha256: emptyScope.scopeSha256,
    scope: emptyScope,
    sourceRevision: 4,
    sourceRuntime: CURRENT_RUNTIME,
    operationId: jobId,
    createdAt: '2026-08-28T20:58:12.000Z',
    pins: [jobId]
  };
  const safetyMetadataPath = path.join(backupsPath, safetyArchiveName.replace(/\.zip$/u, '.json'));
  jsonWrite(safetyMetadataPath, safetyMetadata);

  const [targetInspection, candidateInspection] = await Promise.all([
    inspectServerDirectoryTree(firstTargetFive.serverPath, { reparseInspector: noReparse }),
    inspectServerDirectoryTree(paths.candidatePath, { reparseInspector: noReparse })
  ]);
  const active = {
    schemaVersion: 2,
    sequence: 12,
    jobId,
    operationKind: 'rollback',
    target: { kind: 'existing', stableServerId: firstTargetFive.instanceId, path: firstTargetFive.serverPath },
    candidatePath: paths.candidatePath,
    rollbackPath: paths.rollbackPath,
    failedPath: paths.failedPath,
    restorePoint: { id: safetyRestoreId, sha256: safetyMetadata.sha256 },
    restoreCreation: null,
    journalPath: path.join(
      paths.candidatePath,
      '.minecraft-core-state',
      'operations',
      jobId,
      'journal.json'
    ),
    priorRuntime: { running: false, autoRestart: false },
    phase: 'validating-candidate',
    swapStep: 'none',
    directoryIdentities: {
      target: targetInspection.directoryIdentity,
      candidate: candidateInspection.directoryIdentity,
      rollback: null,
      failed: null
    },
    createdAt: '2026-08-28T20:58:13.940Z',
    updatedAt: '2026-08-28T20:59:00.000Z',
    outcome: {
      live: { fingerprint: targetInspection.fingerprint },
      runtime: { maxRam: 4, port: 25565, source: CURRENT_RUNTIME, target: INITIAL_RUNTIME },
      runtimePolicy: { targetRunning: false, targetAutoRestart: false, targetInactive: false },
      target: { name: 'server' },
      revision: { source: 3, target: 5 }
    }
  };
  const activePath = path.join(lifecycleRoot, 'active', `${jobId}.json`);
  jsonWrite(activePath, active);
  jsonWrite(path.join(lifecycleRoot, 'active', `${jobId}.target.json`), createRecoveryTargetEnvelope(active));
  const failedJob = {
    type: 'minecraft-core-modpack-job',
    schemaVersion: 1,
    sequence: 9,
    jobId,
    operationKind: 'rollback-restore-point',
    serverId: firstTargetFive.instanceId,
    planFingerprint: '6'.repeat(64),
    phase: 'failed',
    swapStep: null,
    progress: { percent: 43, message: 'Restoring the selected verified server snapshot', currentItem: null },
    cancellationRequested: false,
    createdAt: '2026-08-28T20:58:08.060Z',
    updatedAt: '2026-08-28T21:01:02.147Z',
    terminalAt: '2026-08-28T21:01:02.147Z',
    outcome: {
      status: 'failed',
      message: 'The operation failed before the server changed',
      errorCode: 'COMMIT_FAILED',
      cleanupPending: true,
      actions: [
        { actionId: 'change-selection', opaqueRef: `oa:cs:${jobId}` },
        { actionId: 'open-details', opaqueRef: `oa:od:${jobId}` }
      ]
    },
    events: [],
    checksum: ''
  };
  failedJob.checksum = operationChecksum(failedJob);
  const publicJobPath = path.join(lifecycleRoot, 'operations', `${jobId}.json`);
  jsonWrite(publicJobPath, failedJob);
  const terminalRecord = await terminalizeFixtureActiveRollback({
    ...firstTargetFive,
    jobId,
    candidatePath: paths.candidatePath,
    activePath
  }, '2026-08-28T21:00:35.448Z');
  return {
    ...firstTargetFive,
    priorTargetFiveJobId: firstTargetFive.jobId,
    jobId,
    candidatePath: paths.candidatePath,
    activePath,
    publicJobPath,
    safetyMetadataPath,
    recoveredRecordPath: path.join(lifecycleRoot, 'history', `${jobId}.json`),
    recoveredJobIds: [firstTargetFive.recoveredJobId, firstTargetFive.jobId, jobId],
    terminalRecord
  };
}

async function markManagementFixtureFreshRollbackCompleted(fixture, { omitSentinelFromManifest = false } = {}) {
  await fsp.mkdir(path.dirname(fixture.initialManagedLivePath), { recursive: true });
  await fsp.mkdir(path.dirname(fixture.secondaryInitialManagedLivePath), { recursive: true });
  await Promise.all([
    fsp.rm(fixture.managedModPath, { force: true }),
    fsp.writeFile(fixture.initialManagedLivePath, 'initial managed mod', 'utf8'),
    fsp.writeFile(fixture.secondaryInitialManagedLivePath, 'managed=true\n', 'utf8')
  ]);
  jsonWrite(path.join(fixture.serverPath, '.minecraft-core-state', 'modpack.json'), {
    ...fixture.initialState,
    contentRevision: 5
  });
  jsonWrite(
    path.join(fixture.serverPath, '.minecraft-core-state', 'manifests', `${fixture.initialManifest.installationId}.json`),
    omitSentinelFromManifest
      ? { ...fixture.initialManifest, entries: fixture.initialManifest.entries.filter(entry => entry.path !== 'world/minecraft-core-real-e2e.keep') }
      : fixture.initialManifest
  );
  jsonWrite(fixture.coordinatorConfigPath, { contentRevision: 5 });
  jsonWrite(path.join(fixture.serverPath, '.minecraft-core-state', 'history', 'job-management-fresh-rollback.json'), {
    schemaVersion: 1,
    operationId: 'job-management-fresh-rollback',
    sequence: 4,
    kind: 'rollback',
    outcome: 'completed',
    timestamp: '2026-08-28T20:30:00.000Z',
    sourceRevision: 4,
    targetRevision: 5,
    restorePointId: 'restore-management-fresh-safety',
    restorePointSha256: '5'.repeat(64),
    restorePointTotalBytes: '1',
    sourceRuntime: CURRENT_RUNTIME,
    targetRuntime: INITIAL_RUNTIME
  });
  return fixture;
}

async function markManagementFixturePostRollbackCompleted(fixture) {
  const terminal = await markManagementFixturePostRecoveryTerminalLineage(fixture);
  const lifecycleRoot = path.join(terminal.userDataPath, 'modpack-lifecycle');
  const historyRoot = path.join(lifecycleRoot, 'history');
  const operationsRoot = path.join(lifecycleRoot, 'operations');
  const jobId = 'job-management-completed-rollback';
  const restorePointId = 'restore-management-completed-rollback-safety';
  const siblingPaths = createExistingSiblingPaths(terminal.serverPath, jobId);

  await markManagementFixtureFreshRollbackCompleted(terminal, { omitSentinelFromManifest: true });

  const completedManifestEntries = [];
  async function addCompletedManifestEntry(relative, { origin, managementPolicy, role }, bytes) {
    const filePath = path.join(terminal.serverPath, ...relative.split('/'));
    await fsp.mkdir(path.dirname(filePath), { recursive: true });
    await fsp.writeFile(filePath, bytes, 'utf8');
    completedManifestEntries.push({
      path: relative,
      pathKey: relative.toLocaleLowerCase('en-US'),
      origin,
      managementPolicy,
      role,
      installedHash: sha256File(filePath),
      size: String(fs.statSync(filePath).size),
      priorBaseline: null
    });
  }
  await addCompletedManifestEntry('mods/managed-initial.jar', {
    origin: 'pack', managementPolicy: 'replaceable-managed', role: 'mod'
  }, 'initial managed mod');
  for (let index = 1; index < 21; index += 1) {
    await addCompletedManifestEntry(`mods/generated-pack-${String(index).padStart(3, '0')}.jar`, {
      origin: 'pack', managementPolicy: 'replaceable-managed', role: 'mod'
    }, `generated pack mod ${index}\n`);
  }
  for (let index = 0; index < 354; index += 1) {
    await addCompletedManifestEntry(`libraries/generated-${String(index).padStart(3, '0')}.jar`, {
      origin: 'runtime', managementPolicy: 'replaceable-managed', role: 'library'
    }, `generated runtime library ${index}\n`);
  }
  for (let index = 0; index < 78; index += 1) {
    await addCompletedManifestEntry(`.fabric/generated-runtime-${String(index).padStart(3, '0')}.jar`, {
      origin: 'runtime', managementPolicy: 'replaceable-managed', role: 'runtime'
    }, `generated runtime file ${index}\n`);
  }
  for (let index = 0; index < 2; index += 1) {
    await addCompletedManifestEntry(`runtime/generated-server-${index}.jar`, {
      origin: 'runtime', managementPolicy: 'replaceable-managed', role: 'server'
    }, `generated server runtime ${index}\n`);
  }
  for (let index = 0; index < 20; index += 1) {
    await addCompletedManifestEntry(`config/generated-user-${String(index).padStart(3, '0')}.txt`, {
      origin: 'user', managementPolicy: 'protected', role: 'other'
    }, `generated user config ${index}\n`);
  }
  for (let index = 0; index < 23; index += 1) {
    await addCompletedManifestEntry(`world/generated-user-${String(index).padStart(3, '0')}.dat`, {
      origin: 'user', managementPolicy: 'protected', role: 'world'
    }, `generated user world ${index}\n`);
  }
  assert.equal(completedManifestEntries.length, 498);
  jsonWrite(
    path.join(terminal.serverPath, '.minecraft-core-state', 'manifests', `${terminal.initialManifest.installationId}.json`),
    { ...terminal.initialManifest, entries: completedManifestEntries }
  );

  const backupsPath = path.join(terminal.serverPath, 'backups');
  const emptyScope = scopeForEntries([]);
  const archiveName = 'restore-point-management-completed-rollback-safety.zip';
  const archivePath = path.join(backupsPath, archiveName);
  await fsp.writeFile(archivePath, 'completed rollback safety verified archive', 'utf8');
  const metadata = {
    schemaVersion: 1,
    kind: 'minecraft-core-lifecycle-restore-point',
    id: restorePointId,
    name: archiveName,
    sha256: sha256File(archivePath),
    size: fs.statSync(archivePath).size,
    scopeSha256: emptyScope.scopeSha256,
    scope: emptyScope,
    sourceRevision: 4,
    sourceRuntime: CURRENT_RUNTIME,
    operationId: jobId,
    createdAt: '2026-08-28T21:23:26.754Z',
    pins: [jobId]
  };
  jsonWrite(path.join(backupsPath, archiveName.replace(/\.zip$/u, '.json')), metadata);

  const repairJobId = 'job-management-repair';
  const repairRestorePointId = 'restore-management-repair-safety';
  const repairArchiveName = 'restore-point-management-repair-safety.zip';
  const repairArchivePath = path.join(backupsPath, repairArchiveName);
  await fsp.writeFile(repairArchivePath, 'repair safety verified archive', 'utf8');
  const repairMetadata = {
    schemaVersion: 1,
    kind: 'minecraft-core-lifecycle-restore-point',
    id: repairRestorePointId,
    name: repairArchiveName,
    sha256: sha256File(repairArchivePath),
    size: fs.statSync(repairArchivePath).size,
    scopeSha256: emptyScope.scopeSha256,
    scope: emptyScope,
    sourceRevision: 1,
    sourceRuntime: INITIAL_RUNTIME,
    operationId: repairJobId,
    createdAt: '2026-08-28T18:28:20.015Z',
    pins: [repairJobId]
  };
  jsonWrite(path.join(backupsPath, repairArchiveName.replace(/\.zip$/u, '.json')), repairMetadata);

  const managedHistoryRoot = path.join(terminal.serverPath, '.minecraft-core-state', 'history');
  await fsp.rm(path.join(managedHistoryRoot, 'job-management-fresh-rollback.json'));
  jsonWrite(path.join(managedHistoryRoot, 'job-management-install.json'), {
    schemaVersion: 1,
    operationId: 'job-management-install',
    sequence: 1,
    kind: 'install',
    outcome: 'completed',
    timestamp: '2026-08-28T18:27:28.273Z',
    sourceRevision: 0,
    targetRevision: 1,
    targetRuntime: INITIAL_RUNTIME
  });
  jsonWrite(path.join(managedHistoryRoot, `${repairJobId}.json`), {
    schemaVersion: 1,
    operationId: repairJobId,
    sequence: 2,
    kind: 'repair',
    outcome: 'completed',
    timestamp: '2026-08-28T18:39:37.470Z',
    sourceRevision: 1,
    targetRevision: 2,
    restorePointId: repairRestorePointId,
    restorePointSha256: repairMetadata.sha256,
    restorePointTotalBytes: String(emptyScope.totalBytes),
    sourceRuntime: INITIAL_RUNTIME,
    targetRuntime: INITIAL_RUNTIME
  });
  jsonWrite(path.join(managedHistoryRoot, `${jobId}.json`), {
    schemaVersion: 1,
    operationId: jobId,
    sequence: 4,
    kind: 'rollback',
    outcome: 'completed',
    timestamp: '2026-08-28T21:26:10.593Z',
    sourceRevision: 4,
    targetRevision: 5,
    restorePointId,
    restorePointSha256: metadata.sha256,
    restorePointTotalBytes: String(emptyScope.totalBytes),
    sourceRuntime: CURRENT_RUNTIME,
    targetRuntime: INITIAL_RUNTIME
  });

  const operationWorkspace = path.join(terminal.serverPath, '.minecraft-core-state', 'operations', jobId);
  await fsp.mkdir(operationWorkspace, { recursive: true });
  const marker = createDirectoryMarker({
    jobId,
    operationKind: 'rollback',
    stableInstanceId: terminal.instanceId,
    createdAt: '2026-08-28T21:24:34.730Z'
  });
  jsonWrite(path.join(operationWorkspace, 'directory-marker.json'), marker);
  const targetInspection = await inspectServerDirectoryTree(terminal.serverPath, { reparseInspector: noReparse });
  const rollbackIdentity = { volumeSerial: targetInspection.directoryIdentity.volumeSerial, fileId: '1' };
  const sourceFingerprint = terminal.terminalRecord.outcome.live.fingerprint;
  const candidateFingerprint = '7'.repeat(64);
  const revisionEventId = `modpack-content-revision:${jobId}:5`;
  const journal = new OperationJournal({
    durableFs: durableJsonFixture(),
    fsApi: fs,
    clock: () => new Date('2026-08-28T21:24:37.943Z')
  });
  const journalPath = path.join(operationWorkspace, 'journal.json');
  await journal.create(journalPath, {
    jobId,
    operationKind: 'rollback',
    stableInstanceId: terminal.instanceId,
    targetPath: terminal.serverPath,
    candidateIdentity: targetInspection.directoryIdentity,
    markerSha256: marker.checksum
  });
  await journal.transition(journalPath, {
    expectedPhase: 'staging',
    nextPhase: 'completed',
    patch: {
      swapStep: 'cleanup-complete',
      targetIdentity: targetInspection.directoryIdentity,
      rollbackIdentity,
      sourceFingerprint,
      candidateFingerprint,
      rollbackFingerprint: sourceFingerprint,
      revisionEventId,
      revisionEventPublished: true
    }
  });

  const recovery = {
    schemaVersion: 2,
    sequence: 22,
    jobId,
    operationKind: 'rollback',
    target: { kind: 'existing', stableServerId: terminal.instanceId, path: terminal.serverPath },
    candidatePath: siblingPaths.candidatePath,
    rollbackPath: siblingPaths.rollbackPath,
    failedPath: siblingPaths.failedPath,
    restorePoint: { id: restorePointId, sha256: metadata.sha256 },
    restoreCreation: null,
    journalPath,
    priorRuntime: { running: false, autoRestart: false },
    phase: 'completed',
    swapStep: 'cleanup-complete',
    directoryIdentities: {
      target: targetInspection.directoryIdentity,
      candidate: targetInspection.directoryIdentity,
      rollback: rollbackIdentity,
      failed: null
    },
    createdAt: '2026-08-28T21:23:15.256Z',
    updatedAt: '2026-08-28T21:31:46.406Z',
    outcome: {
      live: { fingerprint: sourceFingerprint },
      runtime: { maxRam: 4, port: 25565, source: CURRENT_RUNTIME, target: INITIAL_RUNTIME },
      runtimePolicy: {
        targetRunning: false,
        targetAutoRestart: false,
        targetInactive: false,
        handoffEventId: null,
        runningRestored: false
      },
      target: { name: 'server' },
      revision: { source: 3, target: 5 },
      candidate: {
        fingerprint: candidateFingerprint,
        markerSha256: marker.checksum,
        properties: { existed: false, sha256: null }
      },
      copy: { bytes: '0', files: '0' },
      rollback: { fingerprint: sourceFingerprint },
      swap: { step: 'candidate-published' },
      liveValidation: { properties: { existed: false, sha256: null } },
      health: {
        elapsedMs: 1000,
        endpoint: { host: '127.0.0.1', port: 25565 },
        handedOff: false,
        kind: 'live',
        listenerOwned: true,
        live: true,
        motdNonce: 'minecraft-core-health:test-nonce',
        operationId: 'health-test-completed-rollback',
        pid: 1234,
        pongMatched: true,
        properties: { existed: false, sha256: null },
        readyMarker: 'Done (',
        shutdown: { clean: true, closed: true, exitCode: 0, forced: false, signal: null }
      },
      revisionEvent: { eventId: revisionEventId, published: true },
      releaseTracking: {
        schemaVersion: 1,
        action: 'upsert',
        status: 'applied',
        serverId: terminal.instanceId,
        trackingId: `tracking-${terminal.instanceId}`,
        record: {
          trackingId: `tracking-${terminal.instanceId}`,
          serverId: terminal.instanceId,
          provider: 'modrinth',
          projectId: 'ca0m6gMz',
          repositoryId: null,
          githubOwner: null,
          githubRepo: null,
          includePrereleases: false,
          acceptedMapping: null,
          assetPattern: null,
          etag: null,
          lastSuccessfulCheck: null,
          lastFailure: null,
          nextDueAt: '2026-08-28T21:27:34.868Z',
          lastSnapshot: {
            releaseId: 'oQ6gSIoF',
            version: 'v1.2-1.20.1',
            prerelease: false,
            publishedAt: '2026-08-28T21:27:34.868Z',
            assetFingerprint: null,
            installable: true
          }
        }
      },
      cleanup: { deletionAuthorized: true, rollbackRemoved: true }
    }
  };
  jsonWrite(path.join(historyRoot, `${jobId}.json`), recovery);
  jsonWrite(path.join(historyRoot, `${jobId}.target.json`), createRecoveryTargetEnvelope(recovery));

  const publicJob = {
    type: 'minecraft-core-modpack-job',
    schemaVersion: 1,
    sequence: 19,
    jobId,
    operationKind: 'rollback-restore-point',
    serverId: terminal.instanceId,
    planFingerprint: '8'.repeat(64),
    phase: 'completed',
    swapStep: null,
    progress: { percent: 100, message: 'Modpack operation completed', currentItem: null },
    cancellationRequested: false,
    createdAt: '2026-08-28T21:23:09.066Z',
    updatedAt: '2026-08-28T21:31:51.428Z',
    terminalAt: '2026-08-28T21:31:51.428Z',
    outcome: {
      status: 'completed',
      message: 'The modpack operation completed successfully',
      operationKind: 'rollback-restore-point',
      actions: [{ actionId: 'open-details', opaqueRef: `oa:od:${jobId}` }]
    },
    events: [],
    checksum: ''
  };
  publicJob.checksum = operationChecksum(publicJob);
  jsonWrite(path.join(operationsRoot, `${jobId}.json`), publicJob);
  return {
    ...terminal,
    completedRollbackJobId: jobId,
    completedRollbackPublicPath: path.join(operationsRoot, `${jobId}.json`),
    completedRollbackRecoveryPath: path.join(historyRoot, `${jobId}.json`),
    completedRollbackOperationWorkspace: operationWorkspace,
    completedRollbackRestorePointId: restorePointId,
    repairRestorePointId
  };
}

async function markManagementFixturePostDetachRestoreFailed(fixture) {
  const rolledBack = await markManagementFixturePostRollbackCompleted(fixture);
  const priorServerPath = `${rolledBack.serverPath}-before-detach`;
  await fsp.rename(rolledBack.serverPath, priorServerPath);
  await fsp.cp(priorServerPath, rolledBack.serverPath, { recursive: true, errorOnExist: true });
  await fsp.rm(priorServerPath, { recursive: true, force: true });
  const lifecycleRoot = path.join(rolledBack.userDataPath, 'modpack-lifecycle');
  const lifecycleHistoryRoot = path.join(lifecycleRoot, 'history');
  const lifecycleOperationsRoot = path.join(lifecycleRoot, 'operations');
  const stateRoot = path.join(rolledBack.serverPath, '.minecraft-core-state');
  const managedHistoryRoot = path.join(stateRoot, 'history');
  const operationWorkspacesRoot = path.join(stateRoot, 'operations');
  const backupsPath = path.join(rolledBack.serverPath, 'backups');
  const detachJobId = 'job-management-completed-detach';
  const failedRestoreJobId = 'job-management-failed-detach-restore';
  const detachRestorePointId = 'restore-management-completed-detach-safety';
  const failedSafetyRestorePointId = 'restore-management-failed-detach-restore-safety';
  const detachPaths = createExistingSiblingPaths(rolledBack.serverPath, detachJobId);
  const failedPaths = createExistingSiblingPaths(rolledBack.serverPath, failedRestoreJobId);

  const managedStatePath = path.join(stateRoot, 'modpack.json');
  const managedState = JSON.parse(await fsp.readFile(managedStatePath, 'utf8'));
  const archivedManagedState = {
    ...managedState,
    source: {
      ...managedState.source,
      version: 'v1.2-1.20.1',
      title: 'Server Optimized',
      artifactSetDigest: 'd'.repeat(64)
    }
  };
  const manifestPath = path.join(stateRoot, 'manifests', `${managedState.manifestId}.json`);
  const manifest = JSON.parse(await fsp.readFile(manifestPath, 'utf8'));
  assert.equal(managedState.modpackManaged, true);
  assert.equal(managedState.contentRevision, 5);
  assert.equal(manifest.entries.length, 498);

  const detachArchiveName = 'restore-point-management-completed-detach-safety.zip';
  const detachArchivePath = path.join(backupsPath, detachArchiveName);
  const detachScope = writeExactFixtureArchive(detachArchivePath, {
    fileCount: 517,
    directoryCount: 202,
    requiredFiles: {
      '.minecraft-core-state/modpack.json': `${JSON.stringify(archivedManagedState, null, 2)}\n`,
      [`.minecraft-core-state/manifests/${managedState.manifestId}.json`]: `${JSON.stringify(manifest, null, 2)}\n`
    }
  });
  assert.equal(detachScope.entries.length, 719);
  const detachMetadata = {
    schemaVersion: 1,
    kind: 'minecraft-core-lifecycle-restore-point',
    id: detachRestorePointId,
    name: detachArchiveName,
    sha256: sha256File(detachArchivePath),
    size: fs.statSync(detachArchivePath).size,
    scopeSha256: detachScope.scopeSha256,
    scope: detachScope,
    sourceRevision: 6,
    sourceRuntime: INITIAL_RUNTIME,
    operationId: detachJobId,
    createdAt: '2026-08-28T21:53:35.426Z',
    pins: [detachJobId]
  };
  const detachMetadataPath = path.join(backupsPath, detachArchiveName.replace(/\.zip$/u, '.json'));
  jsonWrite(detachMetadataPath, detachMetadata);

  const failedSafetyArchiveName = 'restore-point-management-failed-detach-restore-safety.zip';
  const failedSafetyArchivePath = path.join(backupsPath, failedSafetyArchiveName);
  const failedSafetyScope = writeExactFixtureArchive(failedSafetyArchivePath, {
    fileCount: 522,
    directoryCount: 203
  });
  assert.equal(failedSafetyScope.entries.length, 725);
  const failedSafetyMetadata = {
    schemaVersion: 1,
    kind: 'minecraft-core-lifecycle-restore-point',
    id: failedSafetyRestorePointId,
    name: failedSafetyArchiveName,
    sha256: sha256File(failedSafetyArchivePath),
    size: fs.statSync(failedSafetyArchivePath).size,
    scopeSha256: failedSafetyScope.scopeSha256,
    scope: failedSafetyScope,
    sourceRevision: 7,
    sourceRuntime: INITIAL_RUNTIME,
    operationId: failedRestoreJobId,
    createdAt: '2026-08-28T22:00:39.630Z',
    pins: [failedRestoreJobId]
  };
  const failedSafetyMetadataPath = path.join(
    backupsPath,
    failedSafetyArchiveName.replace(/\.zip$/u, '.json')
  );
  jsonWrite(failedSafetyMetadataPath, failedSafetyMetadata);

  jsonWrite(managedStatePath, { ...archivedManagedState, modpackManaged: false, contentRevision: 7 });
  jsonWrite(rolledBack.coordinatorConfigPath, {
    contentRevision: 7,
    modpackManaged: false,
    runtime: INITIAL_RUNTIME
  });
  jsonWrite(path.join(managedHistoryRoot, `${detachJobId}.json`), {
    schemaVersion: 1,
    operationId: detachJobId,
    sequence: 5,
    kind: 'detach',
    outcome: 'completed',
    timestamp: '2026-08-28T21:55:01.851Z',
    sourceRevision: 5,
    targetRevision: 7,
    restorePointId: detachRestorePointId,
    restorePointSha256: detachMetadata.sha256,
    restorePointTotalBytes: String(detachScope.totalBytes),
    sourceRuntime: INITIAL_RUNTIME,
    targetRuntime: INITIAL_RUNTIME
  });

  const targetInspection = await inspectServerDirectoryTree(rolledBack.serverPath, { reparseInspector: noReparse });
  const completedRollbackRecovery = JSON.parse(await fsp.readFile(
    rolledBack.completedRollbackRecoveryPath,
    'utf8'
  ));
  const detachRollbackIdentity = completedRollbackRecovery.directoryIdentities.target;
  const failedCandidateIdentity = {
    volumeSerial: targetInspection.directoryIdentity.volumeSerial,
    fileId: '3'
  };
  const detachSourceFingerprint = 'a'.repeat(64);
  const detachCandidateFingerprint = 'b'.repeat(64);
  const detachPropertiesSha256 = 'c'.repeat(64);
  const detachRevisionEventId = `modpack-content-revision:${detachJobId}:7`;
  const detachWorkspace = path.join(operationWorkspacesRoot, detachJobId);
  await fsp.mkdir(detachWorkspace, { recursive: true });
  const detachMarker = createDirectoryMarker({
    jobId: detachJobId,
    operationKind: 'detach',
    stableInstanceId: rolledBack.instanceId,
    createdAt: '2026-08-28T21:54:49.757Z'
  });
  jsonWrite(path.join(detachWorkspace, 'directory-marker.json'), detachMarker);
  const detachJournalPath = path.join(detachWorkspace, 'journal.json');
  const detachJournal = new OperationJournal({
    durableFs: durableJsonFixture(),
    fsApi: fs,
    clock: () => new Date('2026-08-28T21:54:52.068Z')
  });
  await detachJournal.create(detachJournalPath, {
    jobId: detachJobId,
    operationKind: 'detach',
    stableInstanceId: rolledBack.instanceId,
    targetPath: rolledBack.serverPath,
    candidateIdentity: targetInspection.directoryIdentity,
    markerSha256: detachMarker.checksum
  });
  await detachJournal.transition(detachJournalPath, {
    expectedPhase: 'staging',
    nextPhase: 'completed',
    patch: {
      swapStep: 'cleanup-complete',
      targetIdentity: targetInspection.directoryIdentity,
      rollbackIdentity: detachRollbackIdentity,
      sourceFingerprint: detachSourceFingerprint,
      candidateFingerprint: detachCandidateFingerprint,
      rollbackFingerprint: detachSourceFingerprint,
      revisionEventId: detachRevisionEventId,
      revisionEventPublished: true
    }
  });

  const detachRecovery = {
    ...completedRollbackRecovery,
    sequence: 22,
    jobId: detachJobId,
    operationKind: 'detach',
    target: { kind: 'existing', stableServerId: rolledBack.instanceId, path: rolledBack.serverPath },
    candidatePath: detachPaths.candidatePath,
    rollbackPath: detachPaths.rollbackPath,
    failedPath: detachPaths.failedPath,
    restorePoint: { id: detachRestorePointId, sha256: detachMetadata.sha256 },
    journalPath: detachJournalPath,
    directoryIdentities: {
      target: targetInspection.directoryIdentity,
      candidate: targetInspection.directoryIdentity,
      rollback: detachRollbackIdentity,
      failed: null
    },
    createdAt: '2026-08-28T21:53:25.240Z',
    updatedAt: '2026-08-28T22:00:09.598Z',
    outcome: {
      live: { fingerprint: detachSourceFingerprint },
      runtime: { maxRam: 4, port: 25565, source: INITIAL_RUNTIME, target: INITIAL_RUNTIME },
      runtimePolicy: {
        targetRunning: false,
        targetAutoRestart: false,
        targetInactive: false,
        handoffEventId: null,
        runningRestored: false
      },
      target: { name: 'server' },
      revision: { source: 5, target: 7 },
      candidate: {
        fingerprint: detachCandidateFingerprint,
        markerSha256: detachMarker.checksum,
        properties: { existed: true, sha256: detachPropertiesSha256 }
      },
      copy: { bytes: '1569126978', files: 531 },
      rollback: { fingerprint: detachSourceFingerprint },
      swap: { step: 'candidate-published' },
      liveValidation: { properties: { existed: true, sha256: detachPropertiesSha256 } },
      health: {
        elapsedMs: 31235,
        endpoint: { host: '127.0.0.1', port: 13048 },
        handedOff: false,
        kind: 'live',
        listenerOwned: true,
        live: true,
        motdNonce: 'minecraft-core-health:fixture-detach',
        operationId: 'health-fixture-detach',
        pid: 1234,
        pongMatched: true,
        properties: { existed: true, sha256: detachPropertiesSha256 },
        readyMarker: 'Done (',
        shutdown: { clean: true, closed: true, exitCode: 0, forced: false, signal: null }
      },
      revisionEvent: { eventId: detachRevisionEventId, published: true },
      releaseTracking: {
        schemaVersion: 1,
        action: 'remove',
        status: 'applied',
        serverId: rolledBack.instanceId,
        trackingId: `tracking-${rolledBack.instanceId}`
      },
      cleanup: { deletionAuthorized: true, rollbackRemoved: true }
    }
  };
  jsonWrite(path.join(lifecycleHistoryRoot, `${detachJobId}.json`), detachRecovery);
  jsonWrite(
    path.join(lifecycleHistoryRoot, `${detachJobId}.target.json`),
    createRecoveryTargetEnvelope(detachRecovery)
  );

  function writeCompletedPublicJob({ jobId, operationKind, sequence, createdAt, terminalAt, message = 'Modpack operation completed' }) {
    const publicJob = {
      type: 'minecraft-core-modpack-job',
      schemaVersion: 1,
      sequence,
      jobId,
      operationKind,
      serverId: rolledBack.instanceId,
      planFingerprint: '9'.repeat(64),
      phase: 'completed',
      swapStep: null,
      progress: { percent: 100, message, currentItem: null },
      cancellationRequested: false,
      createdAt,
      updatedAt: terminalAt,
      terminalAt,
      outcome: {
        status: 'completed',
        message: operationKind === 'verify'
          ? 'Managed files verified'
          : 'The modpack operation completed successfully',
        operationKind,
        actions: [{ actionId: 'open-details', opaqueRef: `oa:od:${jobId}` }]
      },
      events: [],
      checksum: ''
    };
    publicJob.checksum = operationChecksum(publicJob);
    jsonWrite(path.join(lifecycleOperationsRoot, `${jobId}.json`), publicJob);
    return publicJob;
  }

  const detachPublic = writeCompletedPublicJob({
    jobId: detachJobId,
    operationKind: 'detach',
    sequence: 18,
    createdAt: '2026-08-28T21:53:20.914Z',
    terminalAt: '2026-08-28T22:00:14.550Z'
  });

  const failedRecovery = {
    ...completedRollbackRecovery,
    sequence: 14,
    jobId: failedRestoreJobId,
    operationKind: 'rollback',
    target: { kind: 'existing', stableServerId: rolledBack.instanceId, path: rolledBack.serverPath },
    candidatePath: failedPaths.candidatePath,
    rollbackPath: failedPaths.rollbackPath,
    failedPath: failedPaths.failedPath,
    restorePoint: { id: failedSafetyRestorePointId, sha256: failedSafetyMetadata.sha256 },
    journalPath: path.join(
      failedPaths.candidatePath,
      '.minecraft-core-state',
      'operations',
      failedRestoreJobId,
      'journal.json'
    ),
    phase: 'failed',
    swapStep: 'none',
    directoryIdentities: {
      target: targetInspection.directoryIdentity,
      candidate: failedCandidateIdentity,
      rollback: targetInspection.directoryIdentity,
      failed: null
    },
    createdAt: '2026-08-28T22:00:29.127Z',
    updatedAt: '2026-08-28T22:02:43.315Z',
    outcome: {
      live: { fingerprint: 'd'.repeat(64) },
      runtime: { maxRam: 4, port: 25565, source: INITIAL_RUNTIME, target: INITIAL_RUNTIME },
      runtimePolicy: { targetRunning: false, targetAutoRestart: false, targetInactive: false },
      target: { name: 'server' },
      revision: { source: 7, target: 8 },
      candidateCleanup: {
        deletionAuthorized: true,
        slot: 'candidate',
        action: 'pre-swap-restored',
        directoryIdentity: failedCandidateIdentity,
        fingerprint: 'e'.repeat(64),
        ownershipMode: 'recorded-identity'
      },
      recovery: { action: 'pre-swap-restored', operationId: failedRestoreJobId }
    }
  };
  jsonWrite(path.join(lifecycleHistoryRoot, `${failedRestoreJobId}.json`), failedRecovery);
  jsonWrite(
    path.join(lifecycleHistoryRoot, `${failedRestoreJobId}.target.json`),
    createRecoveryTargetEnvelope(failedRecovery)
  );

  const failedPublic = {
    type: 'minecraft-core-modpack-job',
    schemaVersion: 1,
    sequence: 9,
    jobId: failedRestoreJobId,
    operationKind: 'rollback-restore-point',
    serverId: rolledBack.instanceId,
    planFingerprint: 'f'.repeat(64),
    phase: 'failed',
    swapStep: null,
    progress: { percent: 43, message: 'Restoring the selected verified server snapshot', currentItem: null },
    cancellationRequested: false,
    createdAt: '2026-08-28T22:00:24.360Z',
    updatedAt: '2026-08-28T22:03:20.095Z',
    terminalAt: '2026-08-28T22:03:20.095Z',
    outcome: {
      status: 'failed',
      message: 'The operation failed before the server changed',
      errorCode: 'COMMIT_FAILED',
      cleanupPending: true,
      actions: [
        { actionId: 'change-selection', opaqueRef: `oa:cs:${failedRestoreJobId}` },
        { actionId: 'open-details', opaqueRef: `oa:od:${failedRestoreJobId}` }
      ]
    },
    events: [],
    checksum: ''
  };
  failedPublic.checksum = operationChecksum(failedPublic);
  const failedPublicPath = path.join(lifecycleOperationsRoot, `${failedRestoreJobId}.json`);
  jsonWrite(failedPublicPath, failedPublic);

  const completedRollbackPaths = createExistingSiblingPaths(
    rolledBack.serverPath,
    rolledBack.completedRollbackJobId
  );
  const supportOperations = [
    ['job-management-install', 'install-new', 31, '2026-08-28T18:19:46.606Z', '2026-08-28T18:27:42.125Z'],
    ['job-management-repair', 'repair', 19, '2026-08-28T18:28:05.841Z', '2026-08-28T18:48:59.094Z'],
    ['job-management-update', 'update', 30, '2026-08-28T18:49:34.007Z', '2026-08-28T19:03:14.519Z'],
    ['job-management-verify-1', 'verify', 2, '2026-08-28T18:27:43.959Z', '2026-08-28T18:27:48.171Z'],
    ['job-management-verify-2', 'verify', 2, '2026-08-28T18:27:50.171Z', '2026-08-28T18:27:53.902Z'],
    ['job-management-verify-3', 'verify', 2, '2026-08-28T18:49:00.681Z', '2026-08-28T18:49:04.698Z'],
    ['job-management-verify-4', 'verify', 2, '2026-08-28T21:52:37.143Z', '2026-08-28T21:52:43.110Z']
  ];
  for (const [jobId, operationKind, sequence, createdAt, terminalAt] of supportOperations) {
    writeCompletedPublicJob({
      jobId,
      operationKind,
      sequence,
      createdAt,
      terminalAt,
      message: operationKind === 'verify' ? 'Managed files verified' : 'Modpack operation completed'
    });
  }

  for (const [jobId, operationKind, revision, createdAt, updatedAt, restorePoint] of [
    ['job-management-install', 'install', { source: 0, target: 1 }, '2026-08-28T18:19:50.308Z', '2026-08-28T18:27:35.036Z', null],
    ['job-management-repair', 'repair', { source: 1, target: 2 }, '2026-08-28T18:28:10.392Z', '2026-08-28T18:48:51.286Z', rolledBack.repairRestorePointId],
    ['job-management-update', 'upgrade', { source: 2, target: 3 }, '2026-08-28T18:49:38.702Z', '2026-08-28T19:03:07.002Z', rolledBack.selectedRestoreId]
  ]) {
    const outcome = { ...completedRollbackRecovery.outcome, revision };
    if (operationKind === 'install') delete outcome.revision;
    const record = {
      ...completedRollbackRecovery,
      jobId,
      operationKind,
      target: {
        ...completedRollbackRecovery.target,
        kind: operationKind === 'install' ? 'new' : 'existing'
      },
      swapStep: operationKind === 'install' ? 'candidate-published' : 'cleanup-complete',
      candidatePath: completedRollbackPaths.candidatePath.replace(rolledBack.completedRollbackJobId, jobId),
      rollbackPath: completedRollbackPaths.rollbackPath.replace(rolledBack.completedRollbackJobId, jobId),
      failedPath: completedRollbackPaths.failedPath.replace(rolledBack.completedRollbackJobId, jobId),
      restorePoint: restorePoint ? { id: restorePoint, sha256: '1'.repeat(64) } : null,
      journalPath: path.join(rolledBack.serverPath, '.minecraft-core-state', 'operations', jobId, 'journal.json'),
      createdAt,
      updatedAt,
      outcome
    };
    jsonWrite(path.join(lifecycleHistoryRoot, `${jobId}.json`), record);
    jsonWrite(path.join(lifecycleHistoryRoot, `${jobId}.target.json`), createRecoveryTargetEnvelope(record));
  }

  return {
    ...rolledBack,
    detachJobId,
    detachPublic,
    detachWorkspace,
    detachMetadataPath,
    detachArchivePath,
    detachRestorePointId,
    failedRestoreJobId,
    failedPublicPath,
    failedRecoveryPath: path.join(lifecycleHistoryRoot, `${failedRestoreJobId}.json`),
    failedSafetyMetadataPath,
    failedSafetyRestorePointId
  };
}

test('management continuation adopts only the exact pre-swap recovery checkpoint and preserves it by default', async () => {
  const fixture = await createManagementFixture();
  try {
    const lifecycle = await loadPreservedRealManagementLifecycle(fixture.root, { reparseInspector: noReparse });
    assert.equal(lifecycle.root, path.resolve(fixture.root));
    assert.equal(lifecycle.serverPath, fixture.serverPath);
    assert.equal(lifecycle.instanceId, fixture.instanceId);
    assert.equal(lifecycle.recovery.jobId, fixture.jobId);
    assert.equal(lifecycle.recovery.phase, 'validating-candidate');
    assert.equal(lifecycle.recovery.swapStep, 'none');
    assert.equal(lifecycle.checkpoint.currentVersionId, 'zH4ppiGM');
    assert.equal(lifecycle.checkpoint.initialVersionId, 'oQ6gSIoF');
    assert.equal(lifecycle.checkpoint.upgradeRestorePointId, fixture.selectedRestoreId);
    assert.equal(lifecycle.checkpoint.worldSentinelPath, fixture.sentinelPath);
    assert.equal(lifecycle.checkpoint.worldSentinelText, SENTINEL_TEXT);
    assert.deepEqual(lifecycle.checkpoint.initialManagedFilePaths, [
      fixture.secondaryInitialManagedLivePath,
      fixture.initialManagedLivePath
    ]);
    assert.deepEqual(lifecycle.checkpoint.movedRestorePayloadNames, ['.fabric']);
    assert.equal(lifecycle.checkpoint.restoreScope.fileCount, 6);
    assert.equal(lifecycle.checkpoint.restoreScope.mismatches, 0);
    assert.equal(lifecycle.serverHost, '127.0.0.1');
    assert.notEqual(lifecycle.serverPort, lifecycle.managementPort);
    await lifecycle.dispose();
    assert.equal(fs.existsSync(fixture.root), true);
  } finally {
    await removeFixture(fixture.root);
  }
});

test('management continuation adopts the exact recovered checkpoint after the fresh rollback failed before mutation', async () => {
  const fixture = await markManagementFixturePostRecoveryPlanStale(await createManagementFixture());
  try {
    const lifecycle = await loadPreservedRealManagementLifecycle(fixture.root, { reparseInspector: noReparse });
    assert.equal(lifecycle.continuationMode, 'post-recovery-plan-stale');
    assert.equal(lifecycle.requiresRecovery, false);
    assert.equal(lifecycle.recovery.jobId, fixture.jobId);
    assert.equal(lifecycle.recovery.failedRollbackJobId, fixture.failedRollbackJobId);
    assert.equal(lifecycle.checkpoint.currentVersionId, 'zH4ppiGM');
    assert.equal(lifecycle.checkpoint.initialVersionId, 'oQ6gSIoF');
    assert.equal(lifecycle.checkpoint.sourceRevision, 3);
    assert.equal(lifecycle.checkpoint.coordinatorRevision, 4);
    assert.equal(lifecycle.checkpoint.rollbackRevision, 5);
    assert.deepEqual((await auditRecoveredManagementLifecycle(lifecycle, { reparseInspector: noReparse })).state, {
      schemaVersion: 1,
      modpackManaged: true,
      source: {
        provider: 'modrinth',
        projectId: 'ca0m6gMz',
        versionId: 'zH4ppiGM'
      },
      runtime: CURRENT_RUNTIME,
      selectedOptionalFiles: [],
      installedAt: '2026-08-28T18:00:00.000Z',
      contentRevision: 3,
      manifestId: 'installation-management-current'
    });
    await lifecycle.dispose();
    assert.equal(fs.existsSync(fixture.root), true);
  } finally {
    await removeFixture(fixture.root);
  }
});

test('management continuation adopts the exact new post-recovery active rollback and requires recovery', async () => {
  const fixture = await markManagementFixturePostRecoveryActive(await createManagementFixture());
  try {
    const lifecycle = await loadPreservedRealManagementLifecycle(fixture.root, { reparseInspector: noReparse });
    assert.equal(lifecycle.continuationMode, 'post-recovery-active');
    assert.equal(lifecycle.requiresRecovery, true);
    assert.equal(lifecycle.recovery.jobId, fixture.jobId);
    assert.equal(lifecycle.recovery.phase, 'validating-candidate');
    assert.equal(lifecycle.recovery.swapStep, 'none');
    assert.equal(lifecycle.checkpoint.sourceRevision, 3);
    assert.equal(lifecycle.checkpoint.coordinatorRevision, 4);
    assert.equal(lifecycle.checkpoint.rollbackRevision, 5);
    assert.deepEqual(lifecycle.checkpoint.movedRestorePayloadNames, ['.fabric']);
    assert.equal(lifecycle.checkpoint.restoreScope.movedFileCount, fixture.movedFabricFileCount);
    assert.equal(lifecycle.checkpoint.restoreScope.mismatches, 0);
    await lifecycle.dispose();
    assert.equal(fs.existsSync(fixture.root), true);
  } finally {
    await removeFixture(fixture.root);
  }
});

test('management continuation adopts the exact fully recovered retry lineage without requesting recovery again', async () => {
  const fixture = await markManagementFixturePostRecoveryTerminalLineage(await createManagementFixture());
  try {
    const lifecycle = await loadPreservedRealManagementLifecycle(fixture.root, { reparseInspector: noReparse });
    assert.equal(lifecycle.continuationMode, 'post-recovery-terminal-lineage');
    assert.equal(lifecycle.requiresRecovery, false);
    assert.equal(lifecycle.recovery.jobId, fixture.jobId);
    assert.deepEqual(lifecycle.recovery.recoveredJobIds, fixture.recoveredJobIds);
    assert.equal(lifecycle.checkpoint.currentVersionId, 'zH4ppiGM');
    assert.equal(lifecycle.checkpoint.initialVersionId, 'oQ6gSIoF');
    assert.equal(lifecycle.checkpoint.sourceRevision, 3);
    assert.equal(lifecycle.checkpoint.coordinatorRevision, 4);
    assert.equal(lifecycle.checkpoint.rollbackRevision, 5);
    assert.equal(lifecycle.checkpoint.safetyRestorePointId, fixture.terminalRecord.restorePoint.id);
    const recovered = await auditRecoveredManagementLifecycle(lifecycle, { reparseInspector: noReparse });
    assert.equal(recovered.state.contentRevision, 3);
    assert.equal(recovered.state.source.versionId, 'zH4ppiGM');
    await lifecycle.dispose();
    assert.equal(fs.existsSync(fixture.root), true);
  } finally {
    await removeFixture(fixture.root);
  }
});

test('management continuation adopts the exact completed rollback checkpoint without running rollback again', async () => {
  const fixture = await markManagementFixturePostRollbackCompleted(await createManagementFixture());
  try {
    const lifecycle = await loadPreservedRealManagementLifecycle(fixture.root, { reparseInspector: noReparse });
    assert.equal(lifecycle.continuationMode, 'post-rollback-completed');
    assert.equal(lifecycle.requiresRecovery, false);
    assert.equal(lifecycle.rollbackCompleted, true);
    assert.equal(lifecycle.recovery.jobId, fixture.completedRollbackJobId);
    assert.deepEqual(lifecycle.recovery.recoveredJobIds, fixture.recoveredJobIds);
    assert.equal(lifecycle.checkpoint.initialVersionId, 'oQ6gSIoF');
    assert.equal(lifecycle.checkpoint.sourceRevision, 3);
    assert.equal(lifecycle.checkpoint.coordinatorRevision, 5);
    assert.equal(lifecycle.checkpoint.rollbackRevision, 5);
    assert.equal(lifecycle.checkpoint.safetyRestorePointId, fixture.completedRollbackRestorePointId);
    const restored = await lifecycle.auditRolledBackManagementLifecycle();
    assert.equal(restored.state.contentRevision, 5);
    assert.equal(restored.state.source.versionId, 'oQ6gSIoF');
    assert.equal(restored.rollbackOperationId, fixture.completedRollbackJobId);
    assert.equal(await fsp.readFile(fixture.sentinelPath, 'utf8'), SENTINEL_TEXT);
    await lifecycle.dispose();
    assert.equal(fs.existsSync(fixture.root), true);
  } finally {
    await removeFixture(fixture.root);
  }
});

test('management continuation adopts the exact detached checkpoint after the restore failed before swap', async () => {
  const fixture = await markManagementFixturePostDetachRestoreFailed(await createManagementFixture());
  try {
    const lifecycle = await loadPreservedRealManagementLifecycle(fixture.root, { reparseInspector: noReparse });
    assert.equal(lifecycle.continuationMode, 'post-detach-restore-failed');
    assert.equal(lifecycle.requiresRecovery, false);
    assert.equal(lifecycle.rollbackCompleted, true);
    assert.equal(lifecycle.detachCompleted, true);
    assert.equal(lifecycle.recovery.jobId, fixture.failedRestoreJobId);
    assert.equal(lifecycle.checkpoint.rollbackRevision, 5);
    assert.equal(lifecycle.checkpoint.detachRevision, 7);
    assert.equal(lifecycle.checkpoint.coordinatorRevision, 7);
    assert.equal(lifecycle.checkpoint.detachRestoreRevision, 8);
    assert.equal(lifecycle.checkpoint.detachRestorePointId, fixture.detachRestorePointId);
    const detached = await lifecycle.auditDetachedManagementLifecycle();
    assert.equal(detached.state.modpackManaged, false);
    assert.equal(detached.state.contentRevision, 7);
    assert.equal(detached.state.source.versionId, 'oQ6gSIoF');
    assert.equal(detached.detachOperationId, fixture.detachJobId);
    assert.equal(detached.restorePointId, fixture.detachRestorePointId);
    assert.equal(detached.managedModPath, fixture.initialManagedLivePath);
    assert.equal(await fsp.readFile(fixture.sentinelPath, 'utf8'), SENTINEL_TEXT);
    await lifecycle.dispose();
    assert.equal(fs.existsSync(fixture.root), true);
  } finally {
    await removeFixture(fixture.root);
  }
});

test('post-detach continuation rejects a missing completed detach journal workspace', async () => {
  const fixture = await markManagementFixturePostDetachRestoreFailed(await createManagementFixture());
  try {
    await fsp.rm(fixture.detachWorkspace, { recursive: true, force: true });
    await assert.rejects(
      loadPreservedRealManagementLifecycle(fixture.root, { reparseInspector: noReparse }),
      /completed detach operation workspace|operation workspace topology/iu
    );
    assert.equal(fs.existsSync(fixture.root), true);
  } finally {
    await removeFixture(fixture.root);
  }
});

test('post-detach continuation rejects a changed detach restore archive', async () => {
  const fixture = await markManagementFixturePostDetachRestoreFailed(await createManagementFixture());
  try {
    await fsp.appendFile(fixture.detachArchivePath, 'tamper', 'utf8');
    await assert.rejects(
      loadPreservedRealManagementLifecycle(fixture.root, { reparseInspector: noReparse }),
      /restore archive digest changed/iu
    );
    assert.equal(fs.existsSync(fixture.root), true);
  } finally {
    await removeFixture(fixture.root);
  }
});

test('post-detach continuation rejects a failed restore safety archive bound to another source revision', async () => {
  const fixture = await markManagementFixturePostDetachRestoreFailed(await createManagementFixture());
  try {
    const metadata = JSON.parse(await fsp.readFile(fixture.failedSafetyMetadataPath, 'utf8'));
    jsonWrite(fixture.failedSafetyMetadataPath, { ...metadata, sourceRevision: 6 });
    await assert.rejects(
      loadPreservedRealManagementLifecycle(fixture.root, { reparseInspector: noReparse }),
      /failed detach restore safety evidence/iu
    );
    assert.equal(fs.existsSync(fixture.root), true);
  } finally {
    await removeFixture(fixture.root);
  }
});

test('post-detach continuation rejects detach restore metadata with a different runtime', async () => {
  const fixture = await markManagementFixturePostDetachRestoreFailed(await createManagementFixture());
  try {
    const metadata = JSON.parse(await fsp.readFile(fixture.detachMetadataPath, 'utf8'));
    jsonWrite(fixture.detachMetadataPath, { ...metadata, sourceRuntime: CURRENT_RUNTIME });
    await assert.rejects(
      loadPreservedRealManagementLifecycle(fixture.root, { reparseInspector: noReparse }),
      /selected restore lineage/iu
    );
    assert.equal(fs.existsSync(fixture.root), true);
  } finally {
    await removeFixture(fixture.root);
  }
});

test('post-detach continuation binds detach restore bytes to managed history', async () => {
  const fixture = await markManagementFixturePostDetachRestoreFailed(await createManagementFixture());
  try {
    const historyPath = path.join(
      fixture.serverPath,
      '.minecraft-core-state',
      'history',
      `${fixture.detachJobId}.json`
    );
    const history = JSON.parse(await fsp.readFile(historyPath, 'utf8'));
    jsonWrite(historyPath, { ...history, restorePointTotalBytes: String(Number(history.restorePointTotalBytes) + 1) });
    await assert.rejects(
      loadPreservedRealManagementLifecycle(fixture.root, { reparseInspector: noReparse }),
      /selected restore lineage/iu
    );
    assert.equal(fs.existsSync(fixture.root), true);
  } finally {
    await removeFixture(fixture.root);
  }
});

test('post-detach continuation refuses completion authorization before an uninstall advances past retry revision 8', async () => {
  const fixture = await markManagementFixturePostDetachRestoreFailed(await createManagementFixture());
  try {
    const lifecycle = await loadPreservedRealManagementLifecycle(fixture.root, { reparseInspector: noReparse });
    const statePath = path.join(fixture.serverPath, '.minecraft-core-state', 'modpack.json');
    const state = JSON.parse(await fsp.readFile(statePath, 'utf8'));
    jsonWrite(statePath, {
      ...state,
      modpackManaged: false,
      lifecycleMode: 'uninstalled',
      runtime: null,
      contentRevision: 8,
      manifestId: null
    });
    await assert.rejects(
      lifecycle.confirmCompletedManagement({ managedFilePath: fixture.initialManagedLivePath }),
      /successful uninstall of the restored pack/iu
    );
    await lifecycle.dispose();
    assert.equal(fs.existsSync(fixture.root), true);
  } finally {
    await removeFixture(fixture.root);
  }
});

test('completed rollback checkpoint rejects a changed completed public-operation checksum', async () => {
  const fixture = await markManagementFixturePostRollbackCompleted(await createManagementFixture());
  try {
    const job = JSON.parse(await fsp.readFile(fixture.completedRollbackPublicPath, 'utf8'));
    jsonWrite(fixture.completedRollbackPublicPath, { ...job, checksum: '0'.repeat(64) });
    await assert.rejects(
      loadPreservedRealManagementLifecycle(fixture.root, { reparseInspector: noReparse }),
      /public operation checksum is invalid/iu
    );
    assert.equal(fs.existsSync(fixture.root), true);
  } finally {
    await removeFixture(fixture.root);
  }
});

test('completed rollback checkpoint rejects a missing completed operation journal', async () => {
  const fixture = await markManagementFixturePostRollbackCompleted(await createManagementFixture());
  try {
    await fsp.rm(fixture.completedRollbackOperationWorkspace, { recursive: true, force: true });
    await assert.rejects(
      loadPreservedRealManagementLifecycle(fixture.root, { reparseInspector: noReparse }),
      /completed rollback operation workspace|missing or redirected directory/iu
    );
    assert.equal(fs.existsSync(fixture.root), true);
  } finally {
    await removeFixture(fixture.root);
  }
});

test('fully recovered retry continuation rejects an untracked rollback recovery history pair', async () => {
  const fixture = await markManagementFixturePostRecoveryTerminalLineage(await createManagementFixture());
  try {
    const historyRoot = path.join(fixture.userDataPath, 'modpack-lifecycle', 'history');
    const untrackedJobId = 'job-management-untracked-recovery';
    const untracked = {
      ...fixture.terminalRecord,
      jobId: untrackedJobId,
      outcome: {
        ...fixture.terminalRecord.outcome,
        recovery: { action: 'pre-swap-restored', operationId: untrackedJobId }
      }
    };
    jsonWrite(path.join(historyRoot, `${untrackedJobId}.json`), untracked);
    jsonWrite(path.join(historyRoot, `${untrackedJobId}.target.json`), createRecoveryTargetEnvelope(untracked));
    await assert.rejects(
      loadPreservedRealManagementLifecycle(fixture.root, { reparseInspector: noReparse }),
      /rollback recovery history does not exactly match terminal operations/iu
    );
    assert.equal(fs.existsSync(fixture.root), true);
  } finally {
    await removeFixture(fixture.root);
  }
});

test('fully recovered retry continuation rejects a target-5 history record rewritten as another revision', async () => {
  const fixture = await markManagementFixturePostRecoveryTerminalLineage(await createManagementFixture());
  try {
    const historyRoot = path.join(fixture.userDataPath, 'modpack-lifecycle', 'history');
    const recordPath = path.join(historyRoot, `${fixture.priorTargetFiveJobId}.json`);
    const record = JSON.parse(await fsp.readFile(recordPath, 'utf8'));
    record.outcome.revision.target = 4;
    jsonWrite(recordPath, record);
    jsonWrite(recordPath.replace(/\.json$/u, '.target.json'), createRecoveryTargetEnvelope(record));
    await assert.rejects(
      loadPreservedRealManagementLifecycle(fixture.root, { reparseInspector: noReparse }),
      /terminal retry recovery is not the exact pre-swap restoration/iu
    );
    assert.equal(fs.existsSync(fixture.root), true);
  } finally {
    await removeFixture(fixture.root);
  }
});

test('fully recovered retry continuation rejects a latest safety restore bound to the wrong source revision', async () => {
  const fixture = await markManagementFixturePostRecoveryTerminalLineage(await createManagementFixture());
  try {
    const metadata = JSON.parse(await fsp.readFile(fixture.safetyMetadataPath, 'utf8'));
    jsonWrite(fixture.safetyMetadataPath, { ...metadata, sourceRevision: 3 });
    await assert.rejects(
      loadPreservedRealManagementLifecycle(fixture.root, { reparseInspector: noReparse }),
      /safety restore does not match recovered durable history/iu
    );
    assert.equal(fs.existsSync(fixture.root), true);
  } finally {
    await removeFixture(fixture.root);
  }
});

test('fully recovered retry continuation validates every terminal public operation checksum', async () => {
  const fixture = await markManagementFixturePostRecoveryTerminalLineage(await createManagementFixture());
  try {
    const latest = JSON.parse(await fsp.readFile(fixture.publicJobPath, 'utf8'));
    jsonWrite(fixture.publicJobPath, { ...latest, checksum: '0'.repeat(64) });
    await assert.rejects(
      loadPreservedRealManagementLifecycle(fixture.root, { reparseInspector: noReparse }),
      /public operation checksum is invalid/iu
    );
    assert.equal(fs.existsSync(fixture.root), true);
  } finally {
    await removeFixture(fixture.root);
  }
});

test('post-recovery active continuation rejects a target-5 rollback without the terminal recovered lineage', async () => {
  const fixture = await markManagementFixturePostRecoveryActive(await createManagementFixture());
  try {
    const recoveredRecordPath = path.join(
      fixture.userDataPath,
      'modpack-lifecycle',
      'history',
      `${fixture.recoveredJobId}.json`
    );
    const recovered = JSON.parse(await fsp.readFile(recoveredRecordPath, 'utf8'));
    recovered.outcome.recovery.action = 'candidate-preserved';
    jsonWrite(recoveredRecordPath, recovered);
    jsonWrite(
      recoveredRecordPath.replace(/\.json$/u, '.target.json'),
      createRecoveryTargetEnvelope(recovered)
    );
    await assert.rejects(
      loadPreservedRealManagementLifecycle(fixture.root, { reparseInspector: noReparse }),
      /historical record is not the exact terminal pre-swap restoration/iu
    );
    assert.equal(fs.existsSync(fixture.root), true);
  } finally {
    await removeFixture(fixture.root);
  }
});

test('post-recovery active continuation rejects a different moved .fabric file count even with a self-consistent scope', async () => {
  const fixture = await markManagementFixturePostRecoveryActive(await createManagementFixture());
  try {
    const fabricPath = path.join(fixture.candidatePath, '.fabric');
    const selectedRestorePath = path.join(
      fixture.candidatePath,
      '.minecraft-core-state',
      'operations',
      fixture.jobId,
      'selected-restore'
    );
    const movedFiles = (await fsp.readdir(path.join(fabricPath, 'processedMods'))).sort();
    await fsp.rm(path.join(fabricPath, 'processedMods', movedFiles[0]));
    const selectedScope = scopeForEntries([
      { path: '.fabric/', type: 'directory', size: 0, sha256: null },
      ...enumerateTree(fabricPath, '.fabric/'),
      ...enumerateTree(selectedRestorePath)
    ]);
    const backupsPath = path.join(fixture.serverPath, 'backups');
    const selectedMetadataPath = (await Promise.all((await fsp.readdir(backupsPath))
      .filter(name => name.endsWith('.json'))
      .map(async name => ({
        path: path.join(backupsPath, name),
        value: JSON.parse(await fsp.readFile(path.join(backupsPath, name), 'utf8'))
      })))).find(item => item.value.id === fixture.selectedRestoreId)?.path;
    const selectedMetadata = JSON.parse(await fsp.readFile(selectedMetadataPath, 'utf8'));
    jsonWrite(selectedMetadataPath, {
      ...selectedMetadata,
      scopeSha256: selectedScope.scopeSha256,
      scope: selectedScope
    });
    const upgradeHistoryPath = path.join(
      fixture.serverPath,
      '.minecraft-core-state',
      'history',
      'job-management-update.json'
    );
    const upgrade = JSON.parse(await fsp.readFile(upgradeHistoryPath, 'utf8'));
    jsonWrite(upgradeHistoryPath, { ...upgrade, restorePointTotalBytes: String(selectedScope.totalBytes) });
    const active = JSON.parse(await fsp.readFile(fixture.activePath, 'utf8'));
    active.outcome.live.fingerprint = (await inspectServerDirectoryTree(fixture.serverPath, {
      reparseInspector: noReparse
    })).fingerprint;
    jsonWrite(fixture.activePath, active);
    jsonWrite(fixture.activePath.replace(/\.json$/u, '.target.json'), createRecoveryTargetEnvelope(active));

    await assert.rejects(
      loadPreservedRealManagementLifecycle(fixture.root, { reparseInspector: noReparse }),
      /exact 77-file moved \.fabric payload/iu
    );
    assert.equal(fs.existsSync(fixture.root), true);
  } finally {
    await removeFixture(fixture.root);
  }
});

test('post-recovery active continuation rejects a coordinator revision outside the recovered checkpoint', async () => {
  const fixture = await markManagementFixturePostRecoveryActive(await createManagementFixture());
  try {
    jsonWrite(fixture.coordinatorConfigPath, { contentRevision: 5 });
    const active = JSON.parse(await fsp.readFile(fixture.activePath, 'utf8'));
    active.outcome.live.fingerprint = (await inspectServerDirectoryTree(fixture.serverPath, {
      reparseInspector: noReparse
    })).fingerprint;
    jsonWrite(fixture.activePath, active);
    jsonWrite(fixture.activePath.replace(/\.json$/u, '.target.json'), createRecoveryTargetEnvelope(active));
    await assert.rejects(
      loadPreservedRealManagementLifecycle(fixture.root, { reparseInspector: noReparse }),
      /coordinator revision is not the exact recovered checkpoint/iu
    );
    assert.equal(fs.existsSync(fixture.root), true);
  } finally {
    await removeFixture(fixture.root);
  }
});

test('post-recovery continuation binds cleanup to every file in the freshly restored managed manifest', async () => {
  const fixture = await markManagementFixturePostRecoveryPlanStale(await createManagementFixture());
  try {
    const lifecycle = await loadPreservedRealManagementLifecycle(fixture.root, { reparseInspector: noReparse });
    await markManagementFixtureFreshRollbackCompleted(fixture);
    const restored = await lifecycle.auditRolledBackManagementLifecycle();
    assert.equal(restored.state.source.versionId, 'oQ6gSIoF');
    assert.equal(restored.state.contentRevision, 5);
    assert.equal(restored.managedModPath, fixture.initialManagedLivePath);
    assert.deepEqual(restored.managedFilePaths, [
      fixture.secondaryInitialManagedLivePath,
      fixture.initialManagedLivePath
    ]);
  } finally {
    await removeFixture(fixture.root);
  }
});

test('rolled-back audit accepts a later user sentinel absent from the restored old immutable manifest', async () => {
  const fixture = await markManagementFixturePostRecoveryPlanStale(await createManagementFixture());
  try {
    const lifecycle = await loadPreservedRealManagementLifecycle(fixture.root, { reparseInspector: noReparse });
    await markManagementFixtureFreshRollbackCompleted(fixture, { omitSentinelFromManifest: true });
    const restored = await lifecycle.auditRolledBackManagementLifecycle();
    assert.equal(restored.state.source.versionId, 'oQ6gSIoF');
    assert.equal(await fsp.readFile(fixture.sentinelPath, 'utf8'), SENTINEL_TEXT);
  } finally {
    await removeFixture(fixture.root);
  }
});

test('rolled-back audit still rejects changed bytes for a later untracked user sentinel', async () => {
  const fixture = await markManagementFixturePostRecoveryPlanStale(await createManagementFixture());
  try {
    const lifecycle = await loadPreservedRealManagementLifecycle(fixture.root, { reparseInspector: noReparse });
    await markManagementFixtureFreshRollbackCompleted(fixture, { omitSentinelFromManifest: true });
    await fsp.writeFile(fixture.sentinelPath, 'changed world data\n', 'utf8');
    await assert.rejects(lifecycle.auditRolledBackManagementLifecycle(), /world sentinel changed/iu);
    assert.equal(fs.existsSync(fixture.root), true);
  } finally {
    await removeFixture(fixture.root);
  }
});

test('pre-rollback checkpoint still requires the sentinel in the current immutable manifest', async () => {
  const fixture = await createManagementFixture();
  try {
    const state = JSON.parse(await fsp.readFile(
      path.join(fixture.serverPath, '.minecraft-core-state', 'modpack.json'),
      'utf8'
    ));
    const manifestPath = path.join(
      fixture.serverPath,
      '.minecraft-core-state',
      'manifests',
      `${state.manifestId}.json`
    );
    const manifest = JSON.parse(await fsp.readFile(manifestPath, 'utf8'));
    jsonWrite(manifestPath, {
      ...manifest,
      entries: manifest.entries.filter(entry => entry.path !== 'world/minecraft-core-real-e2e.keep')
    });
    const active = JSON.parse(await fsp.readFile(fixture.activePath, 'utf8'));
    active.outcome.live.fingerprint = (await inspectServerDirectoryTree(fixture.serverPath, {
      reparseInspector: noReparse
    })).fingerprint;
    jsonWrite(fixture.activePath, active);
    jsonWrite(fixture.activePath.replace(/\.json$/u, '.target.json'), createRecoveryTargetEnvelope(active));
    await assert.rejects(
      loadPreservedRealManagementLifecycle(fixture.root, { reparseInspector: noReparse }),
      /world sentinel is not protected by the immutable manifest/iu
    );
  } finally {
    await removeFixture(fixture.root);
  }
});

test('post-recovery continuation rejects a PLAN_STALE job that predates terminal recovery', async () => {
  const fixture = await markManagementFixturePostRecoveryPlanStale(await createManagementFixture());
  try {
    const failedJob = JSON.parse(await fsp.readFile(fixture.failedRollbackJobPath, 'utf8'));
    failedJob.createdAt = '2026-08-28T20:14:10.000Z';
    failedJob.checksum = operationChecksum(failedJob);
    jsonWrite(fixture.failedRollbackJobPath, failedJob);
    await assert.rejects(
      loadPreservedRealManagementLifecycle(fixture.root, { reparseInspector: noReparse }),
      /fresh failed rollback job must follow terminal recovery/iu
    );
  } finally {
    await removeFixture(fixture.root);
  }
});

test('post-recovery continuation rejects unpaired durable recovery history', async () => {
  const fixture = await markManagementFixturePostRecoveryPlanStale(await createManagementFixture());
  try {
    jsonWrite(path.join(path.dirname(fixture.recoveredRecordPath), 'job-management-orphan.json'), {
      schemaVersion: 2,
      jobId: 'job-management-orphan'
    });
    await assert.rejects(
      loadPreservedRealManagementLifecycle(fixture.root, { reparseInspector: noReparse }),
      /durable recovery history topology is invalid/iu
    );
  } finally {
    await removeFixture(fixture.root);
  }
});

test('management continuation remains doubly opt-in and never invents a preserved root', () => {
  assert.equal(getPreservedManagementRoot({}), null);
  assert.equal(getPreservedManagementRoot({ [MANAGEMENT_CONTINUATION_ROOT_ENV]: '   ' }), null);
  assert.equal(isPreservedManagementContinuationEnabled({}), false);
  assert.equal(isPreservedManagementContinuationEnabled({
    MINECRAFT_CORE_REAL_MODPACK_MANAGEMENT_E2E: '1',
    [MANAGEMENT_CONTINUATION_ROOT_ENV]: ' C:\\Temp\\minecraft-core-real-modrinth-management-e2e-explicit '
  }), true);
});

test('management continuation rejects malformed safety-restore scope evidence before recovery', async () => {
  const fixture = await createManagementFixture();
  try {
    const metadata = JSON.parse(await fsp.readFile(fixture.safetyMetadataPath, 'utf8'));
    metadata.scope.scopeSha256 = 'not-a-sha256';
    metadata.scopeSha256 = 'not-a-sha256';
    await fsp.writeFile(fixture.safetyMetadataPath, JSON.stringify(metadata), 'utf8');
    const active = JSON.parse(await fsp.readFile(fixture.activePath, 'utf8'));
    active.outcome.live.fingerprint = (await inspectServerDirectoryTree(fixture.serverPath, {
      reparseInspector: noReparse
    })).fingerprint;
    await fsp.writeFile(fixture.activePath, JSON.stringify(active), 'utf8');

    await assert.rejects(
      loadPreservedRealManagementLifecycle(fixture.root, { reparseInspector: noReparse }),
      /restore scope|restore metadata/iu
    );
    assert.equal(fs.existsSync(fixture.root), true);
  } finally {
    await removeFixture(fixture.root);
  }
});

test('management continuation treats the exact identity as key-value evidence rather than JSON property order', async () => {
  const fixture = await createManagementFixture();
  try {
    await fsp.writeFile(path.join(fixture.root, 'real-lifecycle-identity.json'), JSON.stringify({
      scenario: 'management-lifecycle',
      provider: 'modrinth'
    }), 'utf8');
    const lifecycle = await loadPreservedRealManagementLifecycle(fixture.root, { reparseInspector: noReparse });
    assert.equal(lifecycle.instanceId, fixture.instanceId);
  } finally {
    await removeFixture(fixture.root);
  }
});

test('management continuation fails closed when live or candidate bytes differ from durable evidence', async () => {
  const liveTamper = await createManagementFixture();
  const candidateTamper = await createManagementFixture();
  try {
    await fsp.appendFile(liveTamper.managedModPath, 'tamper', 'utf8');
    await assert.rejects(
      loadPreservedRealManagementLifecycle(liveTamper.root, { reparseInspector: noReparse }),
      /live server identity or fingerprint/iu
    );

    await fsp.appendFile(path.join(candidateTamper.candidatePath, '.fabric', 'processedMods', 'runtime.jar'), 'tamper', 'utf8');
    await assert.rejects(
      loadPreservedRealManagementLifecycle(candidateTamper.root, { reparseInspector: noReparse }),
      /reconstructs the selected verified restore scope/iu
    );
    assert.equal(fs.existsSync(liveTamper.root), true);
    assert.equal(fs.existsSync(candidateTamper.root), true);
  } finally {
    await removeFixture(liveTamper.root);
    await removeFixture(candidateTamper.root);
  }
});

test('post-recovery audit requires exact cleanup topology while allowing runtime log mutation', async () => {
  const fixture = await createManagementFixture();
  try {
    const lifecycle = await loadPreservedRealManagementLifecycle(fixture.root, { reparseInspector: noReparse });
    await fsp.rm(fixture.candidatePath, { recursive: true, force: true });
    for (const name of await fsp.readdir(path.dirname(fixture.activePath))) {
      await fsp.rm(path.join(path.dirname(fixture.activePath), name), { force: true });
    }
    await fsp.mkdir(path.join(fixture.serverPath, 'logs'), { recursive: true });
    await fsp.writeFile(path.join(fixture.serverPath, 'logs', 'latest.log'), 'fresh recovery validation log', 'utf8');

    const recovered = await auditRecoveredManagementLifecycle(lifecycle, { reparseInspector: noReparse });
    assert.equal(recovered.state.source.versionId, 'zH4ppiGM');
    assert.equal(recovered.state.contentRevision, 3);
    assert.notEqual(recovered.fingerprint, lifecycle.checkpoint.preRecoveryFingerprint);
    assert.equal(recovered.upgradeRestorePointId, fixture.selectedRestoreId);
  } finally {
    await removeFixture(fixture.root);
  }
});

test('management continuation deletes only after a disk-audited successful uninstall', async () => {
  const fixture = await createManagementFixture();
  let removed = false;
  try {
    const lifecycle = await loadPreservedRealManagementLifecycle(fixture.root, { reparseInspector: noReparse });
    await assert.rejects(
      lifecycle.dispose({ preserveRoot: false }),
      /refuses deletion without confirmed successful management completion/iu
    );
    assert.equal(fs.existsSync(fixture.root), true);

    await markManagementFixtureCompleted(fixture);

    await assert.rejects(
      lifecycle.confirmCompletedManagement({
        managedFilePath: path.join(fixture.serverPath, 'mods', 'arbitrary-absent.jar')
      }),
      /exact audited rollback managed mod/iu
    );
    assert.deepEqual(await lifecycle.confirmCompletedManagement({ managedFilePath: fixture.initialManagedLivePath }), {
      authorized: true,
      contentRevision: 7
    });
    await fsp.mkdir(path.dirname(fixture.secondaryInitialManagedLivePath), { recursive: true });
    await fsp.writeFile(fixture.secondaryInitialManagedLivePath, 'managed content reappeared after authorization', 'utf8');
    await assert.rejects(
      lifecycle.dispose({ preserveRoot: false }),
      /uninstalled managed mod must be absent/iu
    );
    assert.equal(fs.existsSync(fixture.root), true);
    await fsp.rm(fixture.secondaryInitialManagedLivePath);
    await lifecycle.dispose({ preserveRoot: false });
    removed = true;
    assert.equal(fs.existsSync(fixture.root), false);
  } finally {
    if (!removed && fs.existsSync(fixture.root)) await removeFixture(fixture.root);
  }
});

test('management continuation refuses deletion after the validated root directory is replaced', async () => {
  const fixture = await createManagementFixture();
  const originalRoot = `${fixture.root}-original`;
  try {
    const lifecycle = await loadPreservedRealManagementLifecycle(fixture.root, { reparseInspector: noReparse });
    await markManagementFixtureCompleted(fixture);
    await lifecycle.confirmCompletedManagement({ managedFilePath: fixture.initialManagedLivePath });

    await fsp.rename(fixture.root, originalRoot);
    await fsp.cp(originalRoot, fixture.root, { recursive: true, errorOnExist: true });
    await assert.rejects(
      lifecycle.dispose({ preserveRoot: false }),
      /validated root directory identity changed/iu
    );
    assert.equal(fs.existsSync(fixture.root), true);
    assert.equal(fs.existsSync(originalRoot), true);
  } finally {
    if (fs.existsSync(fixture.root)) await removeFixture(fixture.root);
    if (fs.existsSync(originalRoot)) await removeFixture(originalRoot);
  }
});
