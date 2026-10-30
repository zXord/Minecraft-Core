const assert = require('node:assert/strict');
const crypto = require('node:crypto');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const test = require('node:test');

const { fixtureAuthority, fixtureDurableFs, fixtureRegistry, fixtureRecovery,
  fixtureRestorePreparation, recordFixtureCandidate } = require('./runtime-authority-fixture.cjs');
const {
  ProductionMutationRuntime,
  scanCandidateManifest
} = require('../../electron/services/modpack-lifecycle/production-mutation-runtime.cjs');
const {
  captureExistingUnmanagedTarget,
  captureReservedTarget,
  consumeReservedTarget
} = require('../../electron/services/modpack-lifecycle/reserved-target-authority.cjs');
const { copyServerDirectoryContents } = require('../../electron/services/modpack-lifecycle/server-directory-identity.cjs');
const { planOwnership } = require('../../electron/services/modpacks/planning/ownership-planner.cjs');
const { scanManifest } = require('../../electron/services/modpacks/planning/production-candidate-preparer.cjs');
const { ProductionPlanningAdapter } = require('../../electron/services/modpacks/planning/production-planning-adapter.cjs');
const { createProductionServerSnapshot } = require('../../electron/services/modpacks/planning/production-server-snapshot.cjs');
const { ModpackStateRepository } = require('../../electron/services/modpacks/state/modpack-state-repository.cjs');
const { applyServerNetworkProperties } = require('../../electron/utils/server-network-properties.cjs');

const NOW = '2026-10-30T05:00:00.000Z';
const RUNTIME = Object.freeze({
  minecraftVersion: '1.20.1', loaderFamily: 'forge', loaderVersion: '47.3.0',
  javaMajor: 17, os: 'win32', architecture: 'x64'
});
const SOURCE = Object.freeze({
  provider: 'modrinth', projectId: 'project-one', versionId: 'version-one', version: '1.0.0', title: 'Pack'
});
const reparseInspector = Object.freeze({ async isReparsePoint() { return false; } });
const PACK_FILES = Object.freeze({ 'config/pack.toml': 'enabled=true\n', 'mods/pack.jar': 'pack mod bytes' });
// What a Forge-style loader installer writes while the exact runtime is prepared.
const LOADER_FILES = Object.freeze({
  'libraries/net/minecraft/server/1.20.1/server-1.20.1.jar': 'minecraft server bytes',
  'libraries/net/minecraftforge/forge/1.20.1-47.3.0/win_args.txt': '--launchTarget forge_server\n',
  'run.bat': '@echo off\r\njava @user_jvm_args.txt %*\r\n',
  'run.sh': '#!/usr/bin/env sh\njava @user_jvm_args.txt "$@"\n',
  'user_jvm_args.txt': '# Add custom JVM arguments here\n'
});
const JAVA_FILE = 'java/bin/java.exe';
// Files the runtime preparation writes that the ownership planner always protects.
const PROTECTED_RUNTIME_WRITES = Object.freeze(['run.bat', 'run.sh', 'server.properties', 'user_jvm_args.txt']);
const REVIEWED_REMOVALS = Object.freeze([
  'config/pack.toml',
  JAVA_FILE,
  ...Object.keys(LOADER_FILES).filter(key => key.startsWith('libraries/')),
  'mods/pack.jar'
].sort((left, right) => left.localeCompare(right, 'en-US')));
// What an existing server folder already holds when the pack is installed on it.
const EXISTING_SERVER_FILES = Object.freeze({
  'config/user.toml': 'mine=true\n',
  'mods/user-addon.jar': 'my own mod bytes',
  'ops.json': '[]\n',
  'server.properties': 'motd=mine\nserver-port=25601\n',
  'world/level.dat': 'my world'
});
const EXISTING_SERVER_KEYS = Object.freeze(Object.keys(EXISTING_SERVER_FILES));
// Files a pack may ship (for example as .mrpack overrides) that every review
// protects: a new install seeds them, then they are the server owner's to change.
const PACK_SEEDED_FILES = Object.freeze({
  'banned-players.json': '[]\n',
  'config/jvm.args': '-Xmx4G\n',
  'ops.json': '[]\n',
  'whitelist.json': '[]\n'
});
const PACK_SEEDED_KEYS = Object.freeze(Object.keys(PACK_SEEDED_FILES));

const sha256 = bytes => crypto.createHash('sha256').update(bytes).digest('hex');

function writeFiles(root, files) {
  for (const [relative, text] of Object.entries(files)) {
    const filePath = path.join(root, ...relative.split('/'));
    fs.mkdirSync(path.dirname(filePath), { recursive: true });
    fs.writeFileSync(filePath, text);
  }
}

function tree(root) {
  const result = {};
  (function visit(directory, prefix) {
    for (const entry of fs.readdirSync(directory, { withFileTypes: true }).sort((a, b) => a.name.localeCompare(b.name))) {
      if (!prefix && ['.minecraft-core-state', '.minecraft-core.json'].includes(entry.name)) continue;
      const relative = prefix ? `${prefix}/${entry.name}` : entry.name;
      const absolute = path.join(directory, entry.name);
      if (entry.isDirectory()) visit(absolute, relative);
      else result[relative] = sha256(fs.readFileSync(absolute));
    }
  })(root, '');
  return result;
}

function ownershipOf(entry) {
  return { origin: entry.origin, managementPolicy: entry.managementPolicy, role: entry.role, priorBaseline: entry.priorBaseline };
}

function controlledRuntimeAuthority() {
  return {
    async run(_jobId, work) { return work(); },
    async assertRecoveryAllowed(record) { return record; }
  };
}

function candidateDurableFs() {
  return {
    flushDirectory() {},
    async flushDirectoryAsync() {},
    writeFileAtomic(filePath, bytes) { fs.writeFileSync(filePath, bytes); },
    async writeFileAtomicAsync(filePath, bytes) { fs.writeFileSync(filePath, bytes); },
    renameDurable(source, destination) { fs.renameSync(source, destination); },
    async renameDurableAsync(source, destination) { fs.renameSync(source, destination); },
    readFileBounded(filePath, options = {}) {
      if (options.allowMissing && !fs.existsSync(filePath)) return null;
      return fs.readFileSync(filePath);
    },
    async readFileBoundedAsync(filePath, options = {}) {
      if (options.allowMissing && !fs.existsSync(filePath)) return null;
      return fs.readFileSync(filePath);
    },
    writeJsonAtomic(filePath, value) { fs.writeFileSync(filePath, `${JSON.stringify(value, null, 2)}\n`); },
    async writeJsonAtomicAsync(filePath, value) { fs.writeFileSync(filePath, `${JSON.stringify(value, null, 2)}\n`); }
  };
}

// The production runtime over the real state repository. Java and the loader
// installer write what a Forge install writes (JAVA_FILE and LOADER_FILES).
function lifecycleRuntime({ root, authority, recoveryRegistry, stateRepository, ...dependencies }) {
  const runtimePolicy = {
    suspend() { return { held: true }; },
    async ensureStopped() { return { alreadyStopped: true }; },
    async adoptValidatedHandoff() { return { adopted: true }; },
    restoreAutoRestart() { return { restored: true }; }
  };
  const recoveryServices = {
    registry: recoveryRegistry,
    runtimeWriterAuthority: controlledRuntimeAuthority(),
    runtimePolicy
  };
  recoveryServices.recoveryService = fixtureRecovery({
    authority, registry: recoveryRegistry, durableFs: fixtureDurableFs(root), runtimePolicy, reparseInspector
  });
  return new ProductionMutationRuntime({
    coordinator: authority.coordinator,
    clock: () => new Date(NOW),
    durableFsFactory: candidateDurableFs,
    fsApi: fs,
    healthValidator: {
      async validateCandidate() { return { evidence: { ok: true } }; },
      async validateLive() { return { evidence: { ok: true }, handoff: null }; }
    },
    planValidator() {},
    prepareRuntime: async ({ targetPath: runtimeTarget }) => {
      writeFiles(runtimeTarget, LOADER_FILES);
      return { prepared: true };
    },
    javaManagerFactory(runtimeTarget) {
      return {
        async ensureJava() {
          const javaPath = path.join(runtimeTarget, ...JAVA_FILE.split('/'));
          fs.mkdirSync(path.dirname(javaPath), { recursive: true });
          fs.writeFileSync(javaPath, 'trusted java');
          return { success: true, javaPath };
        }
      };
    },
    recoveryServices,
    releaseTrackingStore: { async list() { return []; }, async remove() { return false; }, async upsert() {} },
    revisionPublisher: { async publishOnce() { return { published: true }; } },
    reparseInspector,
    availableBytes: async () => '999999999999',
    stateRepository,
    store: { get: key => (key === 'instances' ? [] : null), set() {} },
    instanceContext: { updateInstances() {} },
    userDataPath: root,
    ...dependencies
  });
}

function installPlan({ serverKind, instanceId, expectedContentRevision, ownership, paths }) {
  return {
    fingerprint: 'a'.repeat(64),
    operation: { kind: 'install', serverKind, instanceId, expectedContentRevision },
    source: { provider: 'modrinth', projectId: SOURCE.projectId, versionId: SOURCE.versionId, version: SOURCE.version },
    artifact: { setDigest: 'b'.repeat(64) },
    runtime: RUNTIME,
    inspection: { fingerprint: 'c'.repeat(64) },
    ownership,
    selections: {
      optionalFileIds: [], conflictChoices: { paths: {}, categories: {} },
      maxRam: 4, serverPort: 25601, networkAccess: 'loopback'
    },
    preconditions: {
      ...(paths === undefined ? {} : { paths }),
      artifactPartsFingerprint: 'd'.repeat(64), inspectionFingerprint: 'e'.repeat(64),
      ownershipFingerprint: 'f'.repeat(64), selectionsFingerprint: '1'.repeat(64),
      restorePointsFingerprint: '2'.repeat(64), assetPatternFingerprint: '3'.repeat(64),
      acceptedMappingFingerprint: '4'.repeat(64), operationFingerprint: '5'.repeat(64), minimumAvailableBytes: '1'
    }
  };
}

// Installs a new server through the production runtime: the reviewed template
// copy, Java and loader preparation, the server.properties network write, the
// post-runtime ownership scan and the real state repository publication.
async function installNewServer(t, { packFiles = PACK_FILES } = {}) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'minecraft-core-reviewed-install-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const targetPath = path.join(root, 'Reserved Server');
  const templatePath = path.join(root, 'template');
  fs.mkdirSync(targetPath);
  writeFiles(templatePath, packFiles);
  const recoveryRegistry = fixtureRegistry(root);
  const authority = fixtureAuthority({
    instanceId: 'server-new', serverPath: targetPath, jobId: 'job-install', registry: recoveryRegistry
  });
  const stateRepository = new ModpackStateRepository({
    fsApi: fs, durableFs: fixtureDurableFs(root), clock: () => new Date(NOW)
  });
  let executionRecord = null;
  let candidatePath = null;
  const runtime = lifecycleRuntime({
    root,
    authority,
    recoveryRegistry,
    stateRepository,
    consumeReservedTargetFn: consumeReservedTarget,
    destinationReservations: {
      resolve(instanceId) {
        return { instanceId, displayName: 'Reserved Server', targetPath, reservation: executionRecord.reservation };
      },
      consume() { return true; },
      release() { return true; }
    },
    instanceResolver: { async resolveInstance(instanceId) { return { instanceId, serverPath: targetPath, priorRunning: false }; } },
    planningAdapter: { getExecutionRecord() { return executionRecord; } },
    snapshotServer: async () => ({
      liveSnapshot: { kind: 'new', worldDirectories: ['world'], protectedPaths: [], entries: [] },
      pathPreconditions: [],
      sourceRuntime: RUNTIME
    }),
    workspaceRegistry: {
      resolveOwnedWorkspace({ id, kind }) { return { id, kind, path: templatePath }; }
    },
    buildNewCandidateFn: async context => {
      candidatePath = context.expectedPaths?.candidatePath || context.candidatePath;
      fs.mkdirSync(candidatePath, { recursive: true });
      await recordFixtureCandidate(recoveryRegistry, { ...context, candidatePath, reparseInspector });
      await context.materializeCandidate({ candidatePath, jobId: context.jobId });
      await context.persistCandidateState({
        candidatePath, candidateState: context.candidateState, jobId: context.jobId,
        stateRepository: context.stateRepository
      });
      return { candidatePath };
    }
  });
  const incomingManifest = (await scanManifest(templatePath, 'installation-new', { reparseInspector })).manifest;
  executionRecord = {
    execution: { templateOutputId: 'output-template' },
    incomingManifest,
    inspectionResult: { classification: { kind: 'prepared-server-pack' } },
    reservation: await captureReservedTarget({ targetPath, fsApi: fs, reparseInspector }),
    serverKind: 'new',
    source: { ...SOURCE },
    serverPath: targetPath
  };
  const plan = installPlan({
    serverKind: 'new',
    instanceId: 'server-new',
    expectedContentRevision: 0,
    ownership: planOwnership({
      oldManifest: null,
      liveSnapshot: { kind: 'new', worldDirectories: ['world'], protectedPaths: [], entries: [] },
      incomingManifest,
      conflictChoices: {}
    })
  });
  const resolved = { instanceId: 'server-new', serverPath: targetPath, priorRunning: false };
  const choices = { acceptEula: true, startAfterInstall: false, restorePointId: null };
  await authority.run(async lease => {
    await runtime.revalidate({ jobId: 'job-install', plan, choices, resolved, lease });
    await runtime.buildCandidate({
      jobId: 'job-install', operationKind: 'install-new', plan, choices, restorePoint: null, resolved, lease
    });
  });
  // Publication renames the verified candidate into place; the first boot then
  // creates the world and Minecraft saves server.properties again.
  const serverPath = path.join(root, 'Server');
  fs.renameSync(candidatePath, serverPath);
  writeFiles(serverPath, { 'world/level.dat': 'first boot world' });
  rewritePropertiesOnBoot(serverPath);
  return { root, serverPath, stateRepository };
}

// Installs the pack on an existing server folder through the production runtime,
// as 'Install' on a server Minecraft Core already runs does, and as installing
// again after an uninstall does. The private candidate is a full copy of the live
// folder; the runtime adds the reviewed pack files, prepares Java and the loader,
// writes the server.properties network settings, records file ownership and
// writes the real state. Publication then replaces the live folder.
async function installOnExistingServer({ root, serverPath, stateRepository }, jobId) {
  const jobRoot = path.join(root, jobId);
  const templatePath = path.join(jobRoot, 'template');
  writeFiles(templatePath, PACK_FILES);
  const currentState = stateRepository.read(serverPath);
  const contentRevision = currentState?.state.contentRevision ?? 0;
  const recoveryRegistry = fixtureRegistry(jobRoot);
  const authority = fixtureAuthority({
    instanceId: 'server-existing', serverPath, jobId, baseRevision: contentRevision, registry: recoveryRegistry
  });
  const snapshotServer = createProductionServerSnapshot({ fsApi: fs, reparseInspector, stateRepository });
  const incomingManifest = (await scanManifest(templatePath, `installation-${jobId}`, { reparseInspector })).manifest;
  const reviewed = await snapshotServer({
    currentState, operationKind: 'install', runtime: RUNTIME, serverKind: 'existing', serverPath, unmanagedAdoption: true
  });
  const ownership = planOwnership({
    oldManifest: currentState?.manifest ?? null,
    liveSnapshot: reviewed.liveSnapshot,
    incomingManifest,
    conflictChoices: {}
  });
  const executionRecord = {
    execution: { templateOutputId: 'output-template' },
    incomingManifest,
    inspectionResult: { classification: { kind: 'prepared-server-pack' } },
    adoption: await captureExistingUnmanagedTarget({ targetPath: serverPath, fsApi: fs, reparseInspector }),
    reservation: null,
    serverKind: 'existing',
    source: { ...SOURCE },
    serverPath
  };
  let candidatePath = null;
  const runtime = lifecycleRuntime({
    root: jobRoot,
    authority,
    recoveryRegistry,
    stateRepository,
    destinationReservations: { resolve() { return null; }, consume() { return true; }, release() { return true; } },
    instanceResolver: { async resolveInstance(instanceId) { return { instanceId, serverPath, priorRunning: false }; } },
    planningAdapter: { getExecutionRecord() { return executionRecord; } },
    snapshotServer,
    workspaceRegistry: {
      resolveOwnedWorkspace({ id, kind }) { return { id, kind, path: templatePath }; }
    },
    buildExistingCandidateFn: async context => {
      candidatePath = context.candidatePath;
      fs.mkdirSync(candidatePath);
      await recordFixtureCandidate(recoveryRegistry, { ...context, candidatePath, reparseInspector });
      await copyServerDirectoryContents(serverPath, candidatePath, {
        durableFs: { async flushDirectoryAsync() {} }, fsApi: fs, reparseInspector
      });
      await context.applyIncoming({ candidatePath, jobId: context.jobId });
      await context.stateRepository.writeCandidateAsync(candidatePath, context.candidateState);
      return { candidatePath };
    }
  });
  const plan = installPlan({
    serverKind: 'existing',
    instanceId: 'server-existing',
    expectedContentRevision: contentRevision,
    ownership,
    paths: reviewed.pathPreconditions
  });
  const resolved = { instanceId: 'server-existing', serverPath, priorRunning: false };
  const choices = { acceptEula: false, startAfterInstall: false, restorePointId: null };
  await authority.run(async lease => {
    await runtime.revalidate({ jobId, plan, choices, resolved, lease });
    await runtime.buildCandidate({
      jobId, operationKind: 'install-existing', plan, choices, restorePoint: null, resolved, lease
    });
  });
  fs.rmSync(serverPath, { recursive: true, force: true });
  fs.renameSync(candidatePath, serverPath);
  return ownership;
}

// A server folder Minecraft Core already runs without a modpack, as every
// v26.6.1 server is, with the pack then installed on it.
async function adoptedServer(t) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'minecraft-core-reviewed-adoption-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const serverPath = path.join(root, 'Server');
  writeFiles(serverPath, EXISTING_SERVER_FILES);
  const stateRepository = new ModpackStateRepository({
    fsApi: fs, durableFs: fixtureDurableFs(root), clock: () => new Date(NOW)
  });
  const fixture = { root, serverPath, stateRepository };
  fixture.adoptionReview = await installOnExistingServer(fixture, 'job-adopt');
  return fixture;
}

// A managed server with the same files, installed directly through the state
// repository. `legacy` rewrites its manifest the way earlier builds recorded it:
// every file written during runtime preparation as replaceable runtime content,
// and every file the pack seeded as replaceable pack content.
async function managedServer(t, { legacy = false, packFiles = PACK_FILES } = {}) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'minecraft-core-reviewed-uninstall-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const serverPath = path.join(root, 'Server');
  writeFiles(serverPath, { ...packFiles, ...LOADER_FILES, [JAVA_FILE]: 'trusted java', 'world/level.dat': 'world' });
  fs.writeFileSync(path.join(serverPath, 'server.properties'),
    applyServerNetworkProperties(null, { port: 25601, networkAccess: 'loopback' }));
  fs.writeFileSync(path.join(serverPath, '.minecraft-core.json'), JSON.stringify({ contentRevision: 0, port: 25601 }));
  const stateRepository = new ModpackStateRepository({
    fsApi: fs, durableFs: fixtureDurableFs(root), clock: () => new Date(NOW)
  });
  const incomingManifest = {
    schemaVersion: 1,
    installationId: 'installation-managed',
    entries: Object.keys(packFiles).sort().map(key => ({
      path: key, pathKey: key, origin: 'pack', managementPolicy: 'replaceable-managed',
      role: key.startsWith('mods/') ? 'mod' : key.startsWith('config/') ? 'configuration' : 'other',
      installedHash: sha256(fs.readFileSync(path.join(serverPath, ...key.split('/')))),
      size: String(fs.statSync(path.join(serverPath, ...key.split('/'))).size),
      priorBaseline: null
    }))
  };
  const manifest = await scanCandidateManifest({
    candidatePath: serverPath,
    installationId: 'installation-managed',
    incomingManifest,
    runtimePathKeys: new Set([...Object.keys(LOADER_FILES), JAVA_FILE, 'server.properties']),
    reparseInspector
  });
  stateRepository.writeCandidate(serverPath, {
    schemaVersion: 1, modpackManaged: true, source: { ...SOURCE }, runtime: RUNTIME,
    selectedOptionalFiles: [], installedAt: '2026-10-30T04:36:33.330Z', contentRevision: 1, manifest
  });
  if (legacy) {
    const legacyManifest = {
      ...manifest,
      entries: manifest.entries.map(entry => PROTECTED_RUNTIME_WRITES.includes(entry.pathKey)
        ? { ...entry, origin: 'runtime', managementPolicy: 'replaceable-managed', role: 'runtime', priorBaseline: null }
        : PACK_SEEDED_KEYS.includes(entry.pathKey)
          ? { ...entry, origin: 'pack', managementPolicy: 'replaceable-managed' }
          : entry)
    };
    fs.writeFileSync(
      path.join(serverPath, '.minecraft-core-state', 'manifests', `${manifest.installationId}.json`),
      `${JSON.stringify(legacyManifest, null, 2)}\n`
    );
  }
  return { root, serverPath, stateRepository };
}

// The 'Review uninstall' step: the real planning adapter, live snapshot and state.
async function reviewUninstallWithAdapter({ serverPath, stateRepository }) {
  const currentState = stateRepository.read(serverPath);
  const adapter = new ProductionPlanningAdapter({
    instanceResolver: { async resolveInstance(instanceId) { return { instanceId, serverPath, priorRunning: false }; } },
    stateRepository,
    readContentRevision: () => currentState.state.contentRevision,
    reparseInspector,
    validateServerPorts: async () => ({ valid: true, errors: [] }),
    preparePlanInputs: async () => { throw new Error('management planning must not prepare a source candidate'); },
    snapshotServer: createProductionServerSnapshot({ fsApi: fs, reparseInspector, stateRepository }),
    availableBytes: async () => '100000000000',
    workspaceRegistry: { createPlanningSession: () => 'planning-1', createStagingOutput: () => 'output-1', releaseOwner: () => 1 },
    resolveRestorePoint: async () => { throw new Error('not a rollback'); }
  });
  const result = await adapter.createManagementPlan({
    request: { instanceId: 'server-one', operationKind: 'uninstall', selectionRef: null },
    currentState,
    instance: { instanceId: 'server-one', serverPath }
  });
  return { adapter, plan: result.plan };
}

async function reviewUninstall(fixture) {
  return (await reviewUninstallWithAdapter(fixture)).plan;
}

// 'Remove managed pack files' through the production runtime: revalidation of
// the reviewed plan against the stopped server, the verified safety point, the
// full candidate copy and the real state repository uninstall. `afterReview`
// changes the server between the review and the run.
async function uninstallThroughRuntime(fixture, { afterReview = () => {} } = {}) {
  const { root, serverPath, stateRepository } = fixture;
  const jobId = 'job-uninstall';
  const jobRoot = path.join(root, jobId);
  fs.mkdirSync(jobRoot);
  const { adapter, plan } = await reviewUninstallWithAdapter(fixture);
  afterReview(serverPath);
  const uninstallRequests = [];
  const uninstallCandidate = stateRepository.uninstallCandidate.bind(stateRepository);
  stateRepository.uninstallCandidate = (candidatePath, operation) => {
    uninstallRequests.push(structuredClone(operation));
    return uninstallCandidate(candidatePath, operation);
  };
  const recoveryRegistry = fixtureRegistry(jobRoot);
  const authority = fixtureAuthority({
    instanceId: 'server-one', serverPath, jobId,
    baseRevision: plan.operation.expectedContentRevision, registry: recoveryRegistry
  });
  const result = { plan, uninstallRequests, candidatePath: null, candidateBefore: null, persisted: null, liveBefore: null };
  const runtime = lifecycleRuntime({
    root: jobRoot,
    authority,
    recoveryRegistry,
    stateRepository,
    destinationReservations: { resolve() { return null; }, consume() { return true; }, release() { return true; } },
    instanceResolver: { async resolveInstance(instanceId) { return { instanceId, serverPath, priorRunning: false }; } },
    planningAdapter: adapter,
    snapshotServer: createProductionServerSnapshot({ fsApi: fs, reparseInspector, stateRepository }),
    workspaceRegistry: {
      resolveOwnedWorkspace({ id, kind }) { return { id, kind, path: path.join(jobRoot, 'management-output') }; }
    },
    restorePointServiceFactory: () => ({
      prepareVerifiedRestorePointCreation: (request, options) => fixtureRestorePreparation(root, request, options),
      async createVerifiedRestorePoint(request) {
        return {
          id: 'restore-before-uninstall', sha256: '9'.repeat(64), name: 'restore-point-before-uninstall.zip',
          size: 31, totalBytes: '22', scopeSha256: 'b'.repeat(64), operationId: request.operationId,
          createdAt: NOW, sourceRevision: request.sourceRevision, sourceRuntime: request.sourceRuntime
        };
      },
      async restoreToOwnedCandidate() { throw new Error('not a rollback'); }
    }),
    buildExistingCandidateFn: async context => {
      result.candidatePath = context.candidatePath;
      fs.mkdirSync(context.candidatePath);
      await recordFixtureCandidate(recoveryRegistry, { ...context, reparseInspector });
      await copyServerDirectoryContents(serverPath, context.candidatePath, {
        durableFs: { async flushDirectoryAsync() {} }, fsApi: fs, reparseInspector
      });
      await context.applyIncoming({ candidatePath: context.candidatePath, jobId: context.jobId });
      result.candidateBefore = tree(context.candidatePath);
      result.persisted = await context.persistCandidateState({
        candidatePath: context.candidatePath, candidateState: context.candidateState, jobId: context.jobId,
        stateRepository: context.stateRepository
      });
      return { candidatePath: context.candidatePath };
    }
  });
  const resolved = { instanceId: 'server-one', serverPath, priorRunning: false };
  const choices = { acceptEula: false, startAfterInstall: false, restorePointId: null };
  await authority.run(async lease => {
    await runtime.revalidate({ jobId, plan, choices, resolved, lease });
    const restorePoint = await runtime.createRestorePoint({ jobId, plan, resolved });
    result.liveBefore = tree(serverPath);
    await runtime.buildCandidate({
      jobId, operationKind: 'uninstall-managed', plan, choices, restorePoint, resolved, lease
    });
  });
  return result;
}

async function stageCandidate({ root, serverPath }, name = '.op2-regression.c') {
  // The same byte-verified full copy the existing-server transaction makes.
  const candidate = path.join(root, name);
  fs.mkdirSync(candidate);
  await copyServerDirectoryContents(serverPath, candidate, {
    durableFs: { async flushDirectoryAsync() {} }, fsApi: fs, reparseInspector
  });
  return candidate;
}

function reviewedRemovals(plan) {
  return plan.ownership.actions.filter(action => action.action === 'remove').map(action => action.pathKey);
}

function uninstallOperation(plan, contentRevision, overrides = {}) {
  return {
    operationId: 'op2-regression',
    timestamp: NOW,
    contentRevision,
    confirmation: plan.ownership.confirmation,
    removePathKeys: reviewedRemovals(plan),
    restorePointId: 'restore-before-uninstall',
    restorePointSha256: 'a'.repeat(64),
    ...overrides
  };
}

async function liveSnapshotOf({ serverPath, stateRepository }, currentState) {
  const snapshot = await createProductionServerSnapshot({ fsApi: fs, reparseInspector, stateRepository })({
    currentState, operationKind: 'upgrade', runtime: RUNTIME, serverKind: 'existing', serverPath
  });
  return snapshot.liveSnapshot;
}

// Minecraft saves server.properties on every boot with a fresh timestamp header.
function rewritePropertiesOnBoot(serverPath) {
  const propertiesPath = path.join(serverPath, 'server.properties');
  fs.writeFileSync(propertiesPath, `#Minecraft server properties\n#Thu Oct 30 05:10:00 UTC 2026\n${fs.readFileSync(propertiesPath, 'utf8')}`);
}

// After a boot and a JVM tweak neither file matches the bytes recorded at install time.
function editUserOwnedFiles(serverPath) {
  rewritePropertiesOnBoot(serverPath);
  fs.writeFileSync(path.join(serverPath, 'user_jvm_args.txt'), '-Xmx6G\n');
}

// `userFiles` are further files the server owns, such as an existing server's own
// mods and configuration, that every review must keep as well.
async function assertReviewsPreserveProtectedRuntimeWrites(fixture, userFiles = []) {
  editUserOwnedFiles(fixture.serverPath);
  const currentState = fixture.stateRepository.read(fixture.serverPath);
  const liveSnapshot = await liveSnapshotOf(fixture, currentState);
  const nextTemplate = path.join(fixture.root, 'next-template');
  writeFiles(nextTemplate, { ...PACK_FILES, 'config/pack.toml': 'enabled=false\n' });
  const incomingManifest = (await scanManifest(nextTemplate, 'installation-next', { reparseInspector })).manifest;

  const update = planOwnership({ oldManifest: currentState.manifest, liveSnapshot, incomingManifest, conflictChoices: {} });
  assert.deepEqual(update.blocked, [], 'an update review needs no decision about protected files');
  for (const key of [...PROTECTED_RUNTIME_WRITES, ...userFiles]) {
    const action = update.actions.find(item => item.pathKey === key);
    assert.deepEqual([action.action, action.reason], ['preserve-orphan', 'user-owned-content-preserved'], key);
  }
  assert.equal(update.actions.find(item => item.pathKey === 'config/pack.toml').action, 'replace');

  const repair = planOwnership({
    oldManifest: currentState.manifest,
    liveSnapshot,
    incomingManifest: { ...currentState.manifest, installationId: 'installation-repair' },
    operationKind: 'repair',
    conflictChoices: {}
  });
  assert.deepEqual(repair.blocked, []);
  for (const key of [...PROTECTED_RUNTIME_WRITES, ...userFiles]) {
    const action = repair.actions.find(item => item.pathKey === key);
    assert.equal(['unchanged', 'preserve-modified'].includes(action.action), true, `${key}: ${action.action}`);
    assert.equal(action.protected, true, key);
  }
  assert.equal(repair.actions.find(item => item.pathKey === 'server.properties').action, 'preserve-modified');
  assert.equal(repair.actions.find(item => item.pathKey === 'user_jvm_args.txt').action, 'preserve-modified');
}

async function assertReviewedUninstallRemovesExactlyTheReviewedFiles(fixture, {
  userFiles = [],
  operationId = 'op2-regression'
} = {}) {
  const plan = await reviewUninstall(fixture);
  const reviewed = reviewedRemovals(plan).sort((left, right) => left.localeCompare(right, 'en-US'));
  assert.deepEqual(reviewed, REVIEWED_REMOVALS);
  for (const key of [...PROTECTED_RUNTIME_WRITES, ...userFiles]) {
    assert.equal(plan.ownership.actions.find(action => action.pathKey === key).action, 'preserve-orphan', key);
  }
  assert.equal(plan.ownership.confirmation.unchangedManagedRemovalCount, String(REVIEWED_REMOVALS.length));
  const liveBefore = tree(fixture.serverPath);
  const candidate = await stageCandidate(fixture, `.${operationId}.c`);
  const candidateBefore = tree(candidate);
  const contentRevision = fixture.stateRepository.read(fixture.serverPath).state.contentRevision + 1;

  const written = fixture.stateRepository.uninstallCandidate(
    candidate,
    uninstallOperation(plan, contentRevision, { operationId })
  );

  assert.equal(written.confirmation.filesRemoved, String(REVIEWED_REMOVALS.length));
  assert.equal(written.confirmation.preservedModifiedManagedFiles, '0');
  assert.equal(written.state.modpackManaged, false);
  const candidateAfter = tree(candidate);
  const expected = { ...candidateBefore };
  for (const key of REVIEWED_REMOVALS) delete expected[key];
  assert.deepEqual(candidateAfter, expected, 'exactly the reviewed files are removed');
  for (const key of [...PROTECTED_RUNTIME_WRITES, 'world/level.dat', ...userFiles]) {
    assert.ok(candidateBefore[key], key);
    assert.equal(candidateAfter[key], candidateBefore[key], key);
  }
  assert.deepEqual(tree(fixture.serverPath), liveBefore, 'the live folder is untouched');
  return candidate;
}

// After a new install the server owner changes operators, the whitelist and JVM
// arguments the pack seeded. That is neither damage that Verify reports nor
// content that Repair restores or Uninstall removes.
async function assertPackSeededFilesStayTheOwners(fixture) {
  const { manifest } = fixture.stateRepository.read(fixture.serverPath);
  const entries = new Map(manifest.entries.map(entry => [entry.pathKey, entry]));
  for (const key of PACK_SEEDED_KEYS) {
    assert.deepEqual(ownershipOf(entries.get(key)), {
      origin: 'pack', managementPolicy: 'preserve-after-seed',
      role: key.startsWith('config/') ? 'configuration' : 'other', priorBaseline: null
    }, key);
  }
  writeFiles(fixture.serverPath, {
    'config/jvm.args': '-Xmx8G\n',
    'ops.json': '[{"name":"owner","level":4}]\n',
    'whitelist.json': '[{"name":"friend"}]\n'
  });

  const verification = await fixture.stateRepository.verifyManagedFiles(fixture.serverPath);
  assert.equal(verification.healthy, true);
  assert.deepEqual(verification.mismatches, []);
  assert.equal(verification.checkedFiles, String(REVIEWED_REMOVALS.length));

  const currentState = fixture.stateRepository.read(fixture.serverPath);
  const repair = planOwnership({
    oldManifest: currentState.manifest,
    liveSnapshot: await liveSnapshotOf(fixture, currentState),
    incomingManifest: { ...currentState.manifest, installationId: 'installation-repair' },
    operationKind: 'repair',
    conflictChoices: {}
  });
  assert.deepEqual(repair.blocked, []);
  for (const key of PACK_SEEDED_KEYS) {
    const action = repair.actions.find(item => item.pathKey === key);
    assert.deepEqual([action.action, action.protected], [
      key === 'banned-players.json' ? 'unchanged' : 'preserve-modified', true
    ], key);
  }
  await assertReviewedUninstallRemovesExactlyTheReviewedFiles(fixture, { userFiles: PACK_SEEDED_KEYS });
}

// The server's own files and the protected files the runtime preparation wrote
// are the user's; only the pack's files and the Java and loader runtime are managed.
function assertExistingServerOwnership({ serverPath, stateRepository }) {
  const { state, manifest } = stateRepository.read(serverPath);
  assert.equal(state.modpackManaged, true);
  const entries = new Map(manifest.entries.map(entry => [entry.pathKey, entry]));
  for (const key of [...EXISTING_SERVER_KEYS, ...PROTECTED_RUNTIME_WRITES]) {
    assert.deepEqual(ownershipOf(entries.get(key)), {
      origin: 'user', managementPolicy: 'protected', role: key.startsWith('world/') ? 'world' : 'other', priorBaseline: null
    }, key);
  }
  for (const key of [JAVA_FILE, ...Object.keys(LOADER_FILES).filter(item => item.startsWith('libraries/'))]) {
    assert.deepEqual(ownershipOf(entries.get(key)), {
      origin: 'runtime', managementPolicy: 'replaceable-managed', role: 'library', priorBaseline: null
    }, key);
  }
  assert.deepEqual(ownershipOf(entries.get('mods/pack.jar')), {
    origin: 'pack', managementPolicy: 'replaceable-managed', role: 'mod', priorBaseline: null
  });
  assert.deepEqual(ownershipOf(entries.get('config/pack.toml')), {
    origin: 'pack', managementPolicy: 'replaceable-managed', role: 'configuration', priorBaseline: null
  });
  assert.deepEqual([...entries.keys()].sort((left, right) => left.localeCompare(right, 'en-US')), [
    ...new Set([...EXISTING_SERVER_KEYS, ...PROTECTED_RUNTIME_WRITES, ...REVIEWED_REMOVALS])
  ].sort((left, right) => left.localeCompare(right, 'en-US')));
}

test('a new install records runtime-written server.properties, JVM arguments and launch scripts as the user\'s protected files', async t => {
  const fixture = await installNewServer(t);
  const { state, manifest } = fixture.stateRepository.read(fixture.serverPath);
  assert.equal(state.modpackManaged, true);
  const entries = new Map(manifest.entries.map(entry => [entry.pathKey, entry]));
  for (const key of PROTECTED_RUNTIME_WRITES) {
    assert.deepEqual(ownershipOf(entries.get(key)), {
      origin: 'user', managementPolicy: 'protected', role: 'other', priorBaseline: null
    }, key);
  }
  assert.match(fs.readFileSync(path.join(fixture.serverPath, 'server.properties'), 'utf8'), /^server-port=25601$/mu);
  for (const key of [JAVA_FILE, ...Object.keys(LOADER_FILES).filter(item => item.startsWith('libraries/'))]) {
    assert.deepEqual(ownershipOf(entries.get(key)), {
      origin: 'runtime', managementPolicy: 'replaceable-managed', role: 'library', priorBaseline: null
    }, key);
  }
  assert.equal(entries.get('mods/pack.jar').origin, 'pack');
  assert.equal(entries.get('config/pack.toml').origin, 'pack');
  assert.equal(entries.has('eula.txt'), false);
  // The first boot saved server.properties again; that is not managed-file damage.
  const verification = await fixture.stateRepository.verifyManagedFiles(fixture.serverPath);
  assert.equal(verification.healthy, true);
  assert.equal(verification.checkedFiles, String(REVIEWED_REMOVALS.length));
});

test('update and repair reviews of a new install never offer to replace or remove its protected runtime-written files', async t => {
  await assertReviewsPreserveProtectedRuntimeWrites(await installNewServer(t));
});

test('reviewed uninstall of a freshly installed server removes exactly the reviewed files', async t => {
  await assertReviewedUninstallRemovesExactlyTheReviewedFiles(await installNewServer(t));
});

test('reviewed uninstall of a server an earlier build installed removes exactly the reviewed files', async t => {
  await assertReviewedUninstallRemovesExactlyTheReviewedFiles(await managedServer(t, { legacy: true }));
});

test('operator, whitelist, ban and JVM argument files a pack seeds stay the server owner\'s after a new install', async t => {
  await assertPackSeededFilesStayTheOwners(await installNewServer(t, { packFiles: { ...PACK_FILES, ...PACK_SEEDED_FILES } }));
});

test('operator, whitelist, ban and JVM argument files an earlier build recorded as replaceable pack files stay the owner\'s', async t => {
  await assertPackSeededFilesStayTheOwners(await managedServer(t, {
    legacy: true, packFiles: { ...PACK_FILES, ...PACK_SEEDED_FILES }
  }));
});

test('installing the pack on an existing server records the server\'s own files as the user\'s protected files', async t => {
  const fixture = await adoptedServer(t);
  // The install review promised to keep every file the server already had.
  for (const key of EXISTING_SERVER_KEYS) {
    assert.equal(fixture.adoptionReview.actions.find(action => action.pathKey === key).action, 'preserve-user-addon', key);
  }

  assertExistingServerOwnership(fixture);
  for (const [key, text] of Object.entries(EXISTING_SERVER_FILES)) {
    if (key !== 'server.properties') assert.equal(fs.readFileSync(path.join(fixture.serverPath, ...key.split('/')), 'utf8'), text, key);
  }
  const verification = await fixture.stateRepository.verifyManagedFiles(fixture.serverPath);
  assert.equal(verification.healthy, true);
  assert.equal(verification.checkedFiles, String(REVIEWED_REMOVALS.length));
  await assertReviewsPreserveProtectedRuntimeWrites(fixture, EXISTING_SERVER_KEYS);
});

test('reviewed uninstall of a server the pack was installed on keeps the server\'s own files', async t => {
  await assertReviewedUninstallRemovesExactlyTheReviewedFiles(await adoptedServer(t), { userFiles: EXISTING_SERVER_KEYS });
});

test('installing the pack again on an uninstalled server keeps the server\'s own files as the user\'s protected files', async t => {
  const fixture = await adoptedServer(t);
  const uninstalled = await assertReviewedUninstallRemovesExactlyTheReviewedFiles(fixture, { userFiles: EXISTING_SERVER_KEYS });
  // Publication of the uninstall: the server keeps its files but has no manifest.
  fs.rmSync(fixture.serverPath, { recursive: true, force: true });
  fs.renameSync(uninstalled, fixture.serverPath);
  const inactive = fixture.stateRepository.read(fixture.serverPath);
  assert.equal(inactive.state.modpackManaged, false);
  assert.equal(inactive.manifest, null);

  const reinstallReview = await installOnExistingServer(fixture, 'job-reinstall');

  for (const key of [...EXISTING_SERVER_KEYS, ...PROTECTED_RUNTIME_WRITES]) {
    assert.equal(reinstallReview.actions.find(action => action.pathKey === key).action, 'preserve-user-addon', key);
  }
  assertExistingServerOwnership(fixture);
  await assertReviewedUninstallRemovesExactlyTheReviewedFiles(fixture, {
    userFiles: EXISTING_SERVER_KEYS, operationId: 'op2-after-reinstall'
  });
});

test('Remove managed pack files through the production runtime removes exactly the reviewed files', async t => {
  const fixture = await adoptedServer(t);
  const run = await uninstallThroughRuntime(fixture, {
    // The server saved its world while it stopped after the review. The run
    // reconciles the reviewed plan with the stopped server.
    afterReview: serverPath => writeFiles(serverPath, {
      'world/level.dat': 'saved on stop', 'world/region/r.0.0.mca': 'region saved on stop'
    })
  });

  assert.equal(run.uninstallRequests.length, 1);
  const [request] = run.uninstallRequests;
  assert.deepEqual([...request.removePathKeys].sort((left, right) => left.localeCompare(right, 'en-US')), REVIEWED_REMOVALS);
  assert.deepEqual(request.confirmation, run.plan.ownership.confirmation);
  assert.deepEqual([request.restorePointId, request.restorePointSha256], ['restore-before-uninstall', '9'.repeat(64)]);
  assert.equal(run.persisted.state.modpackManaged, false);
  assert.equal(run.persisted.confirmation.filesRemoved, String(REVIEWED_REMOVALS.length));
  assert.equal(run.persisted.confirmation.preservedModifiedManagedFiles, '0');
  const expected = { ...run.candidateBefore };
  for (const key of REVIEWED_REMOVALS) delete expected[key];
  assert.deepEqual(tree(run.candidatePath), expected, 'exactly the reviewed files are removed');
  for (const key of [...EXISTING_SERVER_KEYS, ...PROTECTED_RUNTIME_WRITES, 'world/region/r.0.0.mca']) {
    assert.ok(expected[key], key);
  }
  assert.equal(fs.readFileSync(path.join(run.candidatePath, 'world', 'level.dat'), 'utf8'), 'saved on stop');
  assert.deepEqual(tree(fixture.serverPath), run.liveBefore, 'the live folder is untouched');
});

test('reviewed uninstall refuses a reviewed file that changed after review and removes nothing', async t => {
  const fixture = await managedServer(t, { legacy: true });
  const plan = await reviewUninstall(fixture);
  const candidate = await stageCandidate(fixture);
  fs.appendFileSync(path.join(candidate, 'mods', 'pack.jar'), ' changed after review');
  const before = tree(candidate);

  assert.throws(() => fixture.stateRepository.uninstallCandidate(candidate, uninstallOperation(plan, 2)),
    error => error.code === 'PLAN_STALE');
  assert.deepEqual(tree(candidate), before);
  assert.equal(fixture.stateRepository.read(candidate).state.modpackManaged, true);
  assert.deepEqual(fixture.stateRepository.listHistory(candidate).items, []);
});

test('update and repair reviews never offer to replace or remove protected files an earlier build recorded as runtime', async t => {
  const fixture = await managedServer(t, { legacy: true });
  const { manifest } = fixture.stateRepository.read(fixture.serverPath);
  const entries = new Map(manifest.entries.map(entry => [entry.pathKey, entry]));
  for (const key of PROTECTED_RUNTIME_WRITES) {
    assert.deepEqual(ownershipOf(entries.get(key)), {
      origin: 'user', managementPolicy: 'protected', role: 'other', priorBaseline: null
    }, key);
  }
  assert.equal(entries.get(JAVA_FILE).origin, 'runtime');
  await assertReviewsPreserveProtectedRuntimeWrites(fixture);
});

test('verification and detach treat protected files an earlier build recorded as runtime as the user\'s files', async t => {
  const fixture = await managedServer(t, { legacy: true });
  editUserOwnedFiles(fixture.serverPath);

  const verification = await fixture.stateRepository.verifyManagedFiles(fixture.serverPath);
  assert.equal(verification.healthy, true);
  assert.deepEqual(verification.mismatches, []);
  assert.equal(verification.checkedFiles, String(REVIEWED_REMOVALS.length));

  const detached = fixture.stateRepository.detachCandidate(fixture.serverPath, {
    operationId: 'job-detach', timestamp: NOW, contentRevision: 2
  });
  assert.equal(detached.modpackManaged, false);
  assert.equal(fixture.stateRepository.read(fixture.serverPath).manifest.entries
    .find(entry => entry.pathKey === 'server.properties').origin, 'user');
});

test('uninstall rejects a malformed reviewed removal set before touching the server', async t => {
  const fixture = await managedServer(t);
  const plan = await reviewUninstall(fixture);
  const before = tree(fixture.serverPath);
  const reviewed = reviewedRemovals(plan);
  const confirmation = plan.ownership.confirmation;
  const malformed = [
    ['a missing reviewed set', operation => { delete operation.removePathKeys; }],
    ['a duplicated reviewed path', operation => { operation.removePathKeys = [...reviewed.slice(1), reviewed[1]]; }],
    ['fewer reviewed paths than confirmed', operation => { operation.removePathKeys = reviewed.slice(1); }],
    ['more reviewed paths than confirmed', operation => {
      operation.confirmation = { ...confirmation, unchangedManagedRemovalCount: String(reviewed.length - 1) };
    }],
    ['a non-string reviewed path', operation => { operation.removePathKeys = [...reviewed.slice(1), 7]; }],
    ['an empty reviewed path', operation => { operation.removePathKeys = [...reviewed.slice(1), '']; }],
    ['a reviewed set that is not a list', operation => { operation.removePathKeys = 'mods/pack.jar'; }]
  ];
  for (const [label, mutate] of malformed) {
    const operation = uninstallOperation(plan, 2);
    mutate(operation);
    assert.throws(() => fixture.stateRepository.uninstallCandidate(fixture.serverPath, operation),
      error => error.code === 'INVALID_REQUEST', label);
    assert.deepEqual(tree(fixture.serverPath), before, label);
    assert.equal(fixture.stateRepository.read(fixture.serverPath).state.modpackManaged, true, label);
  }
});

test('uninstall refuses a reviewed path that is not an unchanged managed file and removes nothing', async t => {
  const fixture = await managedServer(t);
  const plan = await reviewUninstall(fixture);
  const before = tree(fixture.serverPath);
  const reviewed = reviewedRemovals(plan);
  for (const outside of ['mods/not-in-manifest.jar', 'server.properties', 'run.bat', 'world/level.dat']) {
    const operation = uninstallOperation(plan, 2, { removePathKeys: [...reviewed.slice(1), outside] });
    assert.throws(() => fixture.stateRepository.uninstallCandidate(fixture.serverPath, operation),
      error => error.code === 'PLAN_STALE', outside);
    assert.deepEqual(tree(fixture.serverPath), before, outside);
    assert.equal(fixture.stateRepository.read(fixture.serverPath).state.modpackManaged, true, outside);
  }
  assert.deepEqual(fixture.stateRepository.listHistory(fixture.serverPath).items, []);
});

test('uninstall keeps an unchanged managed file that was not reviewed for removal', async t => {
  const fixture = await managedServer(t);
  const plan = await reviewUninstall(fixture);
  fs.writeFileSync(path.join(fixture.serverPath, 'config', 'pack.toml'), 'enabled=edited\n');
  const before = tree(fixture.serverPath);

  const written = fixture.stateRepository.uninstallCandidate(fixture.serverPath, uninstallOperation(plan, 2, {
    confirmation: { ...plan.ownership.confirmation, unchangedManagedRemovalCount: '1' },
    removePathKeys: ['mods/pack.jar']
  }));

  const after = tree(fixture.serverPath);
  const expected = { ...before };
  delete expected['mods/pack.jar'];
  assert.deepEqual(after, expected);
  assert.deepEqual(written.confirmation, {
    filesRemoved: '1',
    preservedModifiedManagedFiles: '1',
    possibleNonRunnable: plan.ownership.confirmation.possibleNonRunnable,
    instanceRetained: true,
    worldsRetained: true
  });
});
