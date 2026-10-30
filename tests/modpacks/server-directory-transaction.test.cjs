const assert = require('node:assert/strict');
const crypto = require('node:crypto');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const test = require('node:test');

const { createDurableFs } = require('../../electron/utils/durable-fs.cjs');
const { RecoveryRegistry } = require('../../electron/services/modpack-lifecycle/recovery-registry.cjs');
const {
  issueForgeCandidateHealthAuthorization
} = require('../../electron/services/forge-candidate-health-authorization.cjs');

const noReparse = Object.freeze({
  async isReparsePoint() { return false; }
});

const runtime = Object.freeze({
  minecraftVersion: '1.21.1',
  loaderFamily: 'fabric',
  loaderVersion: '0.16.14',
  javaMajor: 21,
  os: 'win32',
  architecture: 'x64'
});

test('existing swap identifies the rejected await without changing retained directory evidence', async t => {
  const transaction = require('../../electron/services/modpack-lifecycle/server-directory-transaction.cjs');
  const { ModpackError } = require('../../electron/services/modpacks/errors.cjs');
  const { existingSwapCallsiteFromError, publicationFailureDiagnosticFromError,
    filesystemFailureDiagnosticFromError } = require('../../electron/services/modpack-lifecycle/publication-failure-diagnostic.cjs');
  for (const callsite of ['live-moved-journal', 'live-moved-boundary', 'candidate-promotion']) {
    await t.test(callsite, async subtest => {
      // Catches journal/boundary failures being mislabeled as directory promotion, including frozen errors.
      const fixture = await existingFixture(subtest);
      await transaction.buildExistingCandidate(fixture.context);
      const nativeKind = callsite === 'live-moved-journal' ? 'io-failure' : 'sharing-violation';
      const nativeStage = callsite === 'live-moved-journal' ? 'completion-flush' : 'handle-rename';
      const original = Object.freeze(Object.assign(new ModpackError('RECOVERY_REQUIRED', 'Reviewed recovery is required', {
        retryable: true, details: { privatePath: 'C:\\private\\server' },
        cause: Object.assign(new Error('raw private native text'), {
          durableFailureKind: nativeKind, durableFailureStage: nativeStage
        })
      }), { preserveWorkspace: true, runtimeWritersUnproven: true, runtimeFailureCode: 'RUNTIME_INCOMPLETE' }));
      const base = fixture.context.durableFs;
      const journalPath = path.join(fixture.paths.candidatePath, '.minecraft-core-state', 'operations', fixture.context.jobId, 'journal.json');
      fixture.context.durableFs = {
        ...base,
        async writeJsonAtomicAsync(filePath, value, options) {
          const result = await base.writeJsonAtomicAsync(filePath, value, options);
          if (callsite === 'live-moved-journal' && filePath === journalPath && value.swapStep === 'live-moved') throw original;
          return result;
        },
        async renameDurableAsync(source, destination) {
          if (callsite === 'candidate-promotion' && source === fixture.paths.candidatePath) throw original;
          return base.renameDurableAsync(source, destination);
        }
      };
      fixture.context.afterBoundary = async name => {
        if (callsite === 'live-moved-boundary' && name === 'live-moved') throw original;
      };
      await assert.rejects(transaction.swapExistingCandidate(fixture.context), error => {
        assert.equal(existingSwapCallsiteFromError(error), callsite);
        assert.equal(error.cause, original);
        assert.equal(error.code, 'RECOVERY_REQUIRED');
        assert.equal(error.safeMessage, 'Reviewed recovery is required');
        assert.equal(error.retryable, true);
        assert.equal(error.details, original.details);
        for (const flag of ['preserveWorkspace', 'runtimeWritersUnproven', 'runtimeFailureCode']) assert.equal(error[flag], original[flag]);
        assert.deepEqual((callsite === 'candidate-promotion' ? publicationFailureDiagnosticFromError : filesystemFailureDiagnosticFromError)(error), {
          stage: callsite === 'candidate-promotion' ? 'durable-move' : 'filesystem-operation',
          category: nativeKind, boundary: nativeStage
        });
        assert.doesNotMatch(JSON.stringify(error.toPublicResult()), /private|raw native|existingSwapCallsite/);
        return true;
      });
      assert.equal(JSON.parse(fs.readFileSync(journalPath, 'utf8')).swapStep, 'live-moved');
      assert.equal((await fixture.recoveryRegistry.load(fixture.context.jobId)).swapStep, 'live-moved');
      assert.equal(fs.existsSync(fixture.targetPath), false);
      assert.equal(fs.existsSync(fixture.paths.candidatePath), true);
      assert.equal(fs.existsSync(fixture.paths.rollbackPath), true);
    });
  }
});

test('existing swap does not tag failures after candidate promotion has returned', async t => {
  const transaction = require('../../electron/services/modpack-lifecycle/server-directory-transaction.cjs');
  const { existingSwapCallsiteFromError } = require('../../electron/services/modpack-lifecycle/publication-failure-diagnostic.cjs');
  for (const boundary of ['candidate-renamed', 'published-verification', 'published-registry', 'published-journal']) {
    await t.test(boundary, async subtest => {
      // Catches a broad swap catch retaining a stale candidate-promotion label.
      const fixture = await existingFixture(subtest);
      await transaction.buildExistingCandidate(fixture.context);
      const base = fixture.context.durableFs;
      fixture.context.afterBoundary = async name => {
        if (name === 'candidate-renamed' && boundary === 'candidate-renamed') throw new Error('later failure');
        if (name === 'candidate-renamed' && boundary === 'published-verification') {
          fs.appendFileSync(path.join(fixture.targetPath, 'server.jar'), 'tampered');
        }
      };
      fixture.context.durableFs = { ...base, async writeJsonAtomicAsync(filePath, value, options) {
        if (boundary === 'published-journal' && path.basename(filePath) === 'journal.json' && value.swapStep === 'candidate-published') throw new Error('later failure');
        return base.writeJsonAtomicAsync(filePath, value, options);
      } };
      const transition = fixture.recoveryRegistry.transition.bind(fixture.recoveryRegistry);
      fixture.recoveryRegistry.transition = async (jobId, request) => {
        if (boundary === 'published-registry' && request.patch.swapStep === 'candidate-published') throw new Error('later failure');
        return transition(jobId, request);
      };
      await assert.rejects(transaction.swapExistingCandidate(fixture.context), error => {
        assert.equal(existingSwapCallsiteFromError(error), null); return true;
      });
    });
  }
});

test('existing candidate promotion keeps uncertain reconciliation and phase-only evidence closed', async t => {
  const transaction = require('../../electron/services/modpack-lifecycle/server-directory-transaction.cjs');
  const { publicationFailureDiagnosticFromError, existingSwapCallsiteFromError } = require('../../electron/services/modpack-lifecycle/publication-failure-diagnostic.cjs');
  for (const uncertainMove of [false, true]) {
    await t.test(String(uncertainMove), async subtest => {
      // Catches lost commit-phase evidence when promotion reconciliation rejects a moved but changed identity.
      const fixture = await existingFixture(subtest);
      await transaction.buildExistingCandidate(fixture.context);
      const original = Object.seal(Object.assign(new Error('raw native private path'), { commitPhase: 'post-publication-uncertain' }));
      const base = fixture.context.durableFs;
      fixture.context.durableFs = { ...base, async renameDurableAsync(source, destination) {
        if (source === fixture.paths.candidatePath) {
          if (uncertainMove) {
            await base.renameDurableAsync(source, destination);
            fs.renameSync(destination, `${destination}-different-identity`);
            fs.mkdirSync(destination);
          }
          throw original;
        }
        return base.renameDurableAsync(source, destination);
      } };
      await assert.rejects(transaction.swapExistingCandidate(fixture.context), error => {
        assert.equal(existingSwapCallsiteFromError(error), 'candidate-promotion');
        assert.deepEqual(publicationFailureDiagnosticFromError(error), { stage: 'durable-move', category: 'post-publication-uncertain' });
        return true;
      });
      assert.equal(fs.existsSync(fixture.paths.rollbackPath), true);
    });
  }
});

const forgeRuntime = Object.freeze({
  minecraftVersion: '1.12.2',
  loaderFamily: 'forge',
  loaderVersion: '14.23.5.2860',
  javaMajor: 8,
  os: 'win32',
  architecture: 'x64'
});

function publishedRestoreCreation(jobId, sourceRevision = 5) {
  return {
    schemaVersion: 1,
    kind: 'minecraft-core-lifecycle-restore-creation',
    operationId: jobId,
    name: 'restore-point-2026-08-01T00-00-00.000Z-00000000-0000-4000-8000-000000000021.zip',
    partName: 'restore-point-2026-08-01T00-00-00.000Z-00000000-0000-4000-8000-000000000021.zip.part',
    createdAt: '2026-08-01T00:00:00.000Z',
    sourceRevision,
    scopeSha256: 'b'.repeat(64),
    backupDirectory: { existed: true, identity: { dev: '1', ino: '2', birthtimeNs: '3' } },
    partIdentity: { dev: '1', ino: '4', birthtimeNs: '5' },
    archiveSha256: 'a'.repeat(64),
    archiveSize: 123,
    metadataSha256: 'c'.repeat(64),
    metadataIdentity: { dev: '1', ino: '6', birthtimeNs: '7' },
    state: 'published'
  };
}

function nativeDurability() {
  return {
    moveWriteThrough(source, destination) { fs.renameSync(source, destination); },
    async moveWriteThroughAsync(source, destination) {
      await new Promise(resolve => setImmediate(resolve));
      fs.renameSync(source, destination);
    },
    replaceFileWriteThrough(source, destination) { fs.renameSync(source, destination); },
    async replaceFileWriteThroughAsync(source, destination) {
      await new Promise(resolve => setImmediate(resolve));
      fs.renameSync(source, destination);
    },
    flushDirectory() {},
    async flushDirectoryAsync() {}
  };
}

function fixtureRoot(t) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'minecraft-core-existing-swap-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  return root;
}

test('candidate integrity accepts ctime-only drift while hashing stable content', async t => {
  const { inspectServerDirectoryTree } = require(
    '../../electron/services/modpack-lifecycle/server-directory-identity.cjs'
  );
  const root = fixtureRoot(t);
  const serverJar = path.join(root, 'server.jar');
  fs.writeFileSync(serverJar, 'stable candidate bytes');

  let fileLstatCalls = 0;
  const fsPromises = Object.create(fs.promises);
  fsPromises.lstat = async (candidate, options) => {
    const stat = await fs.promises.lstat(candidate, options);
    if (path.resolve(candidate) !== path.resolve(serverJar)) return stat;
    fileLstatCalls += 1;
    const ctimeOffset = fileLstatCalls > 1 ? 1n : 0n;
    return new Proxy(stat, {
      get(target, property) {
        if (property === 'ctimeNs') return target.ctimeNs + ctimeOffset;
        const value = Reflect.get(target, property, target);
        return typeof value === 'function' ? value.bind(target) : value;
      }
    });
  };

  const inspection = await inspectServerDirectoryTree(root, {
    fsApi: fs,
    fsPromises,
    reparseInspector: noReparse
  });

  assert.match(inspection.fingerprint, /^[a-f0-9]{64}$/u);
  assert.equal(inspection.entryCount, 1);
  assert.equal(inspection.totalBytes, String(Buffer.byteLength('stable candidate bytes')));
  assert.ok(fileLstatCalls > 1);
});

test('candidate integrity rejects mtime drift even when the candidate bytes are unchanged', async t => {
  const { inspectServerDirectoryTree } = require(
    '../../electron/services/modpack-lifecycle/server-directory-identity.cjs'
  );
  const root = fixtureRoot(t);
  const serverJar = path.join(root, 'server.jar');
  fs.writeFileSync(serverJar, 'stable candidate bytes');

  let fileLstatCalls = 0;
  const fsPromises = Object.create(fs.promises);
  fsPromises.lstat = async (candidate, options) => {
    const stat = await fs.promises.lstat(candidate, options);
    if (path.resolve(candidate) !== path.resolve(serverJar)) return stat;
    fileLstatCalls += 1;
    const mtimeOffset = fileLstatCalls > 1 ? 1n : 0n;
    return new Proxy(stat, {
      get(target, property) {
        if (property === 'mtimeNs') return target.mtimeNs + mtimeOffset;
        const value = Reflect.get(target, property, target);
        return typeof value === 'function' ? value.bind(target) : value;
      }
    });
  };

  await assert.rejects(
    inspectServerDirectoryTree(root, { fsApi: fs, fsPromises, reparseInspector: noReparse }),
    error => error?.code === 'RECOVERY_REQUIRED'
  );
  assert.ok(fileLstatCalls > 1);
});

test('new operation IDs receive compact sibling paths while legacy jobs retain their recovery paths', () => {
  const {
    createExistingSiblingPaths,
    createSiblingPaths
  } = require('../../electron/services/modpack-lifecycle/server-directory-transaction.cjs');
  const targetPath = 'C:\\Users\\tester\\AppData\\Local\\Temp\\minecraft-core-tfg-gate-07ab39647db84a03b720c8e91f0274aa\\minecraft-core-real-tfg-lifecycle-e2e-qbns1D\\servers\\tfg-real-server';
  const operationId = `op2-${'a'.repeat(32)}`;

  const compact = createExistingSiblingPaths(targetPath, operationId);
  assert.equal(path.win32.basename(compact.candidatePath), `.${operationId}.c`);
  assert.equal(path.win32.basename(compact.failedPath), `.${operationId}.f`);
  assert.equal(path.win32.basename(compact.rollbackPath), `.${operationId}.r`);
  assert.ok(`${compact.candidatePath}\\libraries\\net\\minecraftforge\\forge\\1.20.1-47.4.13\\win_args.txt`.length < 260);

  const legacy = createSiblingPaths(targetPath, 'job-existing-install');
  assert.equal(
    path.win32.basename(legacy.candidatePath),
    '.tfg-real-server.minecraft-core.job-existing-install.candidate'
  );
  assert.equal(
    path.win32.basename(legacy.failedPath),
    '.tfg-real-server.minecraft-core.job-existing-install.failed'
  );
});

async function existingFixture(t, options = {}) {
  const {
    createSiblingPaths
  } = require('../../electron/services/modpack-lifecycle/server-directory-transaction.cjs');
  const root = fixtureRoot(t);
  const servers = path.join(root, 'servers');
  const userDataPath = path.join(root, 'user-data');
  fs.mkdirSync(servers);
  fs.mkdirSync(userDataPath);
  const targetPath = path.join(servers, 'server');
  fs.mkdirSync(targetPath);
  fs.mkdirSync(path.join(targetPath, 'world'));
  fs.writeFileSync(path.join(targetPath, 'server.jar'), 'old-server');
  fs.writeFileSync(path.join(targetPath, 'server.properties'), 'motd=Canonical\nserver-port=25565\n');
  fs.writeFileSync(path.join(targetPath, 'world', 'level.dat'), 'world-state');

  let temporary = 0;
  const durableFs = createDurableFs({
    fsApi: fs,
    durableClient: options.durableClient || nativeDurability(),
    allowedRoots: [root],
    tempNameFactory: () => `existing-swap-${++temporary}`
  });
  let now = Date.parse('2026-08-01T00:00:00.000Z');
  const clock = () => new Date(now += 1000);
  const recoveryRegistry = new RecoveryRegistry({
    userDataPath,
    fsApi: fs,
    durableFs,
    clock,
    randomUUID: () => '00000000-0000-4000-8000-000000000021'
  });
  await recoveryRegistry.initialize();

  const jobId = 'job-existing-swap';
  const stableInstanceId = 'server-existing-swap';
  const sourceRevision = options.sourceRevision ?? 5;
  const baseRevision = options.baseRevision ?? sourceRevision;
  const targetRevision = options.targetRevision ?? (baseRevision + 1);
  const selectedRuntime = options.runtime ?? runtime;
  const basePaths = createSiblingPaths(targetPath, jobId);
  const rollbackPath = path.join(servers, '.server.minecraft-core.job-existing-swap.rollback');
  const paths = Object.freeze({ ...basePaths, rollbackPath });
  await recoveryRegistry.create({
    schemaVersion: 2,
    sequence: 0,
    jobId,
    operationKind: options.operationKind || 'upgrade',
    target: { kind: 'existing', stableServerId: stableInstanceId, path: targetPath },
    candidatePath: paths.candidatePath,
    rollbackPath,
    failedPath: paths.failedPath,
    restorePoint: { id: 'restore-existing', sha256: 'a'.repeat(64) },
    restoreCreation: options.withPublishedRestoreCreation
      ? publishedRestoreCreation(jobId, baseRevision)
      : null,
    journalPath: null,
    priorRuntime: {
      running: options.priorRunning === true,
      autoRestart: options.priorAutoRestart ?? true
    },
    phase: 'queued',
    swapStep: 'none',
    directoryIdentities: { target: null, candidate: null, rollback: null, failed: null },
    createdAt: '2026-08-01T00:00:00.000Z',
    updatedAt: '2026-08-01T00:00:00.000Z',
    outcome: null
  });
  await recoveryRegistry.transition(jobId, {
    expectedPhase: 'queued', nextPhase: 'preflight', patch: {
      ...(options.targetRunning === undefined
        ? {}
        : { outcome: { runtimePolicy: { targetRunning: options.targetRunning } } })
    }
  });
  await recoveryRegistry.transition(jobId, {
    expectedPhase: 'preflight', nextPhase: 'snapshotting', patch: {}
  });

  const calls = [];
  const candidateHealthRequests = [];
  const liveHealthRequests = [];
  const fault = { boundary: null };
  const mutationLease = Object.freeze({
    kind: 'mutation',
    operation: 'modpack-upgrade',
    operationId: jobId,
    instanceId: stableInstanceId,
    serverPath: targetPath,
    baseRevision,
    assertOwnedPath(candidate) { return candidate; },
    markDirty() { calls.push('lease:dirty'); return true; },
    release() { return false; }
  });
  const stateRepository = {
    read(serverPath) {
      assert.equal(serverPath, targetPath);
      if (options.unmanagedAdoption === true) return options.unmanagedCurrentState ?? null;
      return Object.freeze({ state: Object.freeze({ contentRevision: sourceRevision, runtime: selectedRuntime }) });
    },
    writeCandidate() {
      throw new Error('synchronous candidate state publication must not run');
    },
    async writeCandidateAsync(candidatePath, state) {
      calls.push('state:write');
      assert.equal(state.contentRevision, targetRevision);
      fs.writeFileSync(path.join(candidatePath, '.minecraft-core.json'), JSON.stringify({ contentRevision: targetRevision }));
      return Object.freeze({ state: Object.freeze({ contentRevision: targetRevision }) });
    }
  };
  const context = {
    targetPath,
    jobId,
    operationKind: options.operationKind || 'upgrade',
    stableInstanceId,
    durableFs,
    fsApi: fs,
    reparseInspector: noReparse,
    recoveryRegistry,
    mutationLease,
    plan: Object.freeze({ fingerprint: 'reviewed-plan' }),
    currentSnapshot: Object.freeze({ fingerprint: 'current-snapshot' }),
    unmanagedAdoption: options.unmanagedAdoption === true,
    planValidator() { calls.push('plan:validate'); },
    async applyIncoming({ candidatePath }) {
      calls.push('incoming:apply');
      if (options.assertFreshCandidate) await options.assertFreshCandidate(candidatePath);
      fs.writeFileSync(path.join(candidatePath, 'server.jar'), 'new-server');
      fs.mkdirSync(path.join(candidatePath, 'mods'));
      fs.writeFileSync(path.join(candidatePath, 'mods', 'pack.jar'), 'pack-mod');
      if (options.afterIncoming) await options.afterIncoming(candidatePath);
    },
    stateRepository,
    candidateState: Object.freeze({ contentRevision: targetRevision }),
    healthValidator: {
      async validateCandidate(request) {
        candidateHealthRequests.push(request);
        const { candidatePath } = request;
        calls.push('health:candidate');
        assert.equal(fs.readFileSync(path.join(candidatePath, 'server.properties'), 'utf8'), 'motd=Canonical\nserver-port=25565\n');
        if (options.candidateHealthError) throw options.candidateHealthError;
        if (options.mutatePropertiesDuringCandidateHealth) {
          fs.writeFileSync(path.join(candidatePath, 'server.properties'), 'motd=Not restored\n');
        }
        return Object.freeze({ evidence: Object.freeze({ kind: 'candidate' }) });
      },
      async validateLive(request) {
        liveHealthRequests.push(request);
        calls.push('health:live');
        assert.equal(request.keepRunning, options.targetRunning ?? options.priorRunning === true);
        if (options.mutateCanonicalDuringLiveHealth) {
          fs.appendFileSync(path.join(targetPath, 'world', 'level.dat'), '-validated-live-boot');
          fs.mkdirSync(path.join(targetPath, 'logs'), { recursive: true });
          fs.writeFileSync(path.join(targetPath, 'logs', 'latest.log'), 'Done (1.000s)!\n');
        }
        if (options.mutatePropertiesDuringLiveHealth) {
          fs.writeFileSync(path.join(targetPath, 'server.properties'), 'motd=Interrupted validation\nserver-port=25565\n');
        }
        if (options.liveHealthError) throw options.liveHealthError;
        return Object.freeze({
          evidence: Object.freeze({ kind: 'live' }),
          handoff: (options.targetRunning ?? options.priorRunning === true)
            ? (Object.hasOwn(options, 'liveHandoff')
                ? options.liveHandoff
                : Object.freeze({ processHandle: {}, startLease: {} }))
            : null
        });
      }
    },
    runtime: selectedRuntime,
    maxRam: 8,
    port: 25565,
    healthTimeoutMs: 30000,
    clock,
    async afterBoundary(name) {
      calls.push(`boundary:${name}`);
      if (fault.boundary === name) throw new Error(`fault after ${name}`);
    },
    revisionPublisher: {
      async publishOnce(event) {
        if (!calls.includes(`revision:${event.eventId}`)) calls.push(`revision:${event.eventId}`);
      }
    },
    runtimePolicy: {
      async adoptValidatedHandoff(request) {
        calls.push(`handoff:${request.eventId}`);
        if (options.adoptionError) throw options.adoptionError;
        return options.adoptionResult ?? Object.freeze({ adopted: true });
      }
    }
  };
  let forgeCandidateHealthAuthorization = null;
  if (options.authorizeForgeCandidateHealth === true) {
    forgeCandidateHealthAuthorization = issueForgeCandidateHealthAuthorization({
      candidatePath: paths.candidatePath,
      instanceId: stableInstanceId,
      jobId,
      operationKind: options.operationKind || 'upgrade',
      restorePointId: 'restore-existing',
      restorePointSha256: 'a'.repeat(64),
      runtime: selectedRuntime,
      serverPath: targetPath,
      sourceRevision: baseRevision
    });
    context.forgeCandidateHealthAuthorization = forgeCandidateHealthAuthorization;
  }
  if (options.persistCandidateState) context.persistCandidateState = options.persistCandidateState;
  if (options.validateCandidate === false) context.validateCandidate = false;
  if (options.freshCandidate === true) context.freshCandidate = true;
  if (options.authorizeSourceSnapshot) context.authorizeSourceSnapshot = options.authorizeSourceSnapshot;
  if (options.yieldControl) context.yieldControl = options.yieldControl;
  if (options.durabilityHandoff) context.durabilityHandoff = options.durabilityHandoff;
  return {
    calls,
    candidateHealthRequests,
    context,
    fault,
    forgeCandidateHealthAuthorization,
    liveHealthRequests,
    paths,
    recoveryRegistry,
    targetPath
  };
}

async function newLiveFixture(t, suffix, options = {}) {
  const {
    buildNewCandidate,
    createSiblingPaths,
    publishNewCandidate,
    registerPublishedInstance
  } = require('../../electron/services/modpack-lifecycle/server-directory-transaction.cjs');
  const root = fixtureRoot(t);
  const servers = path.join(root, 'servers');
  const userDataPath = path.join(root, 'user-data');
  fs.mkdirSync(servers);
  fs.mkdirSync(userDataPath);
  const targetPath = path.join(servers, 'server');
  const jobId = `job-new-live-${suffix}`;
  const stableInstanceId = `server-new-live-${suffix}`;
  const paths = createSiblingPaths(targetPath, jobId);
  let temporary = 0;
  const durableFs = createDurableFs({
    fsApi: fs,
    durableClient: options.durableClient || nativeDurability(),
    allowedRoots: [root],
    tempNameFactory: () => `new-live-${suffix}-${++temporary}`
  });
  let now = Date.parse('2026-08-01T00:00:00.000Z');
  const clock = () => new Date(now += 1000);
  const recoveryRegistry = new RecoveryRegistry({
    userDataPath,
    fsApi: fs,
    durableFs,
    clock,
    randomUUID: () => '00000000-0000-4000-8000-000000000031'
  });
  await recoveryRegistry.initialize();
  await recoveryRegistry.create({
    schemaVersion: 2,
    sequence: 0,
    jobId,
    operationKind: 'install',
    target: { kind: 'new', stableServerId: stableInstanceId, path: targetPath },
    candidatePath: paths.candidatePath,
    rollbackPath: null,
    failedPath: paths.failedPath,
    restorePoint: null,
    restoreCreation: null,
    journalPath: null,
    priorRuntime: { running: false, autoRestart: false },
    phase: 'queued',
    swapStep: 'none',
    directoryIdentities: { target: null, candidate: null, rollback: null, failed: null },
    createdAt: '2026-08-01T00:00:00.000Z',
    updatedAt: '2026-08-01T00:00:00.000Z',
    outcome: null
  });
  await recoveryRegistry.transition(jobId, {
    expectedPhase: 'queued',
    nextPhase: 'preflight',
    patch: { outcome: { runtimePolicy: { targetRunning: false, targetAutoRestart: false } } }
  });
  const mutationLease = Object.freeze({
    kind: 'mutation',
    operation: 'modpack-install',
    operationId: jobId,
    instanceId: stableInstanceId,
    serverPath: targetPath,
    baseRevision: 0,
    assertOwnedPath(candidate) { return candidate; },
    markDirty() { return true; },
    release() { return false; }
  });
  const healthyCandidateEvidence = Object.freeze({
    handedOff: false,
    kind: 'candidate',
    listenerOwned: true,
    live: true,
    pongMatched: true,
    properties: Object.freeze({ existed: true, sha256: 'a'.repeat(64) }),
    readyMarker: 'Done (1.000s)!',
    shutdown: Object.freeze({ clean: true, closed: true, exitCode: 0, forced: false, signal: null })
  });
  const context = {
    targetPath,
    jobId,
    operationKind: 'install',
    stableInstanceId,
    durableFs,
    fsApi: fs,
    reparseInspector: noReparse,
    recoveryRegistry,
    mutationLease,
    plan: Object.freeze({ fingerprint: 'reviewed-new-plan' }),
    currentSnapshot: Object.freeze({ fingerprint: 'current-new-snapshot' }),
    planValidator() {},
    async materializeCandidate({ candidatePath }) {
      fs.writeFileSync(path.join(candidatePath, 'server.jar'), 'new-server');
      fs.writeFileSync(path.join(candidatePath, 'server.properties'), 'motd=New Pack\nserver-port=25565\n');
    },
    stateRepository: {
      writeCandidate() {
        throw new Error('synchronous candidate state publication must not run');
      },
      async writeCandidateAsync(candidatePath) {
        fs.writeFileSync(path.join(candidatePath, '.minecraft-core.json'), JSON.stringify({ contentRevision: 1 }));
        return Object.freeze({ contentRevision: 1 });
      }
    },
    candidateState: Object.freeze({ contentRevision: 1 }),
    healthValidator: {
      async validateCandidate() {
        return Object.freeze({
          evidence: options.healthEvidence ?? healthyCandidateEvidence
        });
      }
    },
    runtime,
    maxRam: 8,
    healthTimeoutMs: 30000,
    clock
  };
  if (options.yieldControl) context.yieldControl = options.yieldControl;
  if (options.durabilityHandoff) context.durabilityHandoff = options.durabilityHandoff;
  if (options.beforeBuild) await options.beforeBuild(context);
  await buildNewCandidate(context);
  await publishNewCandidate(context);
  let instances = [];
  await registerPublishedInstance({
    ...context,
    name: 'New live transaction',
    appStore: {
      get() { return structuredClone(instances); },
      set(_key, value) { instances = structuredClone(value); }
    },
    instanceContext: { updateInstances() {} }
  });
  const record = await recoveryRegistry.load(jobId);
  assert.equal(record.phase, 'registering');
  assert.equal(record.outcome.registration.complete, true);
  return { context, durableFs, paths, record, recoveryRegistry, targetPath };
}

test('new live validation requires durable authorization and exact publication provenance', async (t) => {
  const transaction = require('../../electron/services/modpack-lifecycle/server-directory-transaction.cjs');
  const fixture = await newLiveFixture(t, 'authorization-provenance');

  await assert.rejects(
    transaction.verifyMutableNewOperationOwnedDirectory(
      fixture.context,
      fixture.targetPath,
      fixture.record.directoryIdentities.target
    ),
    error => {
      assert.equal(error.code, 'RECOVERY_REQUIRED');
      return true;
    }
  );

  const forgedMarkerSha256 = 'f'.repeat(64);
  await fixture.recoveryRegistry.transition(fixture.context.jobId, {
    expectedPhase: 'registering',
    nextPhase: 'registering',
    patch: {
      outcome: {
        ...fixture.record.outcome,
        publication: {
          ...fixture.record.outcome.publication,
          markerSha256: forgedMarkerSha256
        }
      }
    }
  });

  await assert.rejects(
    transaction.prepareNewLiveValidation(fixture.context),
    error => {
      assert.equal(error.code, 'RECOVERY_REQUIRED');
      return true;
    }
  );
  const rejected = await fixture.recoveryRegistry.load(fixture.context.jobId);
  assert.equal(rejected.phase, 'registering');
  assert.notEqual(rejected.outcome.liveMutationAuthorized, true);
});

test('inactive new publication reuses sealed candidate health without authorizing another boot', async (t) => {
  const transaction = require('../../electron/services/modpack-lifecycle/server-directory-transaction.cjs');
  const fixture = await newLiveFixture(t, 'sealed-candidate-health');

  assert.equal(fixture.record.outcome.candidate.health.kind, 'candidate');
  assert.equal(fixture.record.outcome.candidate.health.shutdown.clean, true);

  const validation = await transaction.verifyPublishedNewCandidate(fixture.context);
  const current = await fixture.recoveryRegistry.load(fixture.context.jobId);

  assert.deepEqual(validation, {
    evidence: {
      ...fixture.record.outcome.candidate.health,
      publicationVerified: true,
      validationSource: 'sealed-candidate'
    },
    handoff: null
  });
  assert.equal(current.phase, 'registering');
  assert.notEqual(current.outcome.liveMutationAuthorized, true);
});

test('sealed candidate health rejects malformed or non-clean boot evidence', async (t) => {
  const healthy = {
    handedOff: false,
    kind: 'candidate',
    listenerOwned: true,
    live: true,
    pongMatched: true,
    properties: { existed: false, sha256: null },
    readyMarker: 'Done (1.000s)!',
    shutdown: { clean: true, closed: true, exitCode: 0, forced: false, signal: null }
  };
  const cases = [
    ['empty', {}],
    ['wrong-kind', { ...healthy, kind: 'live' }],
    ['handed-off', { ...healthy, handedOff: true }],
    ['unclean-shutdown', { ...healthy, shutdown: { ...healthy.shutdown, clean: false } }]
  ];
  for (const [name, healthEvidence] of cases) {
    await t.test(name, async subtest => {
      await assert.rejects(
        newLiveFixture(subtest, `malformed-health-${name}`, { healthEvidence }),
        error => error?.code === 'RECOVERY_REQUIRED'
      );
    });
  }
});

test('sealed candidate health cannot be reused after the published tree changes', async (t) => {
  const transaction = require('../../electron/services/modpack-lifecycle/server-directory-transaction.cjs');
  const fixture = await newLiveFixture(t, 'changed-after-publication');
  fs.appendFileSync(path.join(fixture.targetPath, 'server.jar'), '-changed');

  await assert.rejects(
    transaction.verifyPublishedNewCandidate(fixture.context),
    error => error?.code === 'RECOVERY_REQUIRED'
  );
});

test('committed inactive new publication verifies durable lineage after app-owned history changes', async (t) => {
  const transaction = require('../../electron/services/modpack-lifecycle/server-directory-transaction.cjs');
  const fixture = await newLiveFixture(t, 'committed-history-lineage');
  await fixture.recoveryRegistry.transition(fixture.context.jobId, {
    expectedPhase: 'registering',
    nextPhase: 'committed-healthy',
    patch: {
      outcome: {
        ...fixture.record.outcome,
        health: { kind: 'candidate', live: true },
        runtimePolicy: { targetRunning: false, targetAutoRestart: false },
        revisionEvent: { eventId: 'revision-one', published: true }
      }
    }
  });
  const historyDirectory = path.join(fixture.targetPath, '.minecraft-core-state', 'history');
  fs.mkdirSync(historyDirectory, { recursive: true });
  fs.writeFileSync(path.join(historyDirectory, '0001.json'), '{"outcome":"completed"}\n');

  const verified = await transaction.verifyCommittedNewPublication(fixture.context);

  assert.deepEqual(verified, { phase: 'committed-healthy', verified: true });
});

test('mutable new verifier accepts world and log writes after durable live authorization', async (t) => {
  const transaction = require('../../electron/services/modpack-lifecycle/server-directory-transaction.cjs');
  const fixture = await newLiveFixture(t, 'authorized-mutations');

  const authorization = await transaction.prepareNewLiveValidation(fixture.context);
  const authorized = await fixture.recoveryRegistry.load(fixture.context.jobId);
  assert.equal(authorized.phase, 'validating-live');
  assert.equal(authorized.outcome.liveMutationAuthorized, true);
  assert.deepEqual(authorized.outcome.liveValidation.properties, {
    existed: true,
    sha256: authorization.properties.sha256
  });

  fs.mkdirSync(path.join(fixture.targetPath, 'world'));
  fs.writeFileSync(path.join(fixture.targetPath, 'world', 'level.dat'), 'health-boot-world-write');
  fs.mkdirSync(path.join(fixture.targetPath, 'logs'));
  fs.writeFileSync(path.join(fixture.targetPath, 'logs', 'latest.log'), 'Done (1.000s)!\n');

  const owned = await transaction.verifyMutableNewOperationOwnedDirectory(
    fixture.context,
    fixture.targetPath,
    authorized.directoryIdentities.target
  );
  assert.deepEqual(owned.identity, authorized.directoryIdentities.target);
  assert.deepEqual(
    await transaction.completeNewLiveValidation(fixture.context, authorization),
    { phase: 'validating-live', verified: true }
  );
  assert.equal(
    fs.readFileSync(path.join(fixture.targetPath, 'world', 'level.dat'), 'utf8'),
    'health-boot-world-write'
  );
  assert.equal(
    fs.readFileSync(path.join(fixture.targetPath, 'logs', 'latest.log'), 'utf8'),
    'Done (1.000s)!\n'
  );
});

test('new live completion rejects changed server properties', async (t) => {
  const transaction = require('../../electron/services/modpack-lifecycle/server-directory-transaction.cjs');
  const fixture = await newLiveFixture(t, 'changed-properties');
  const authorization = await transaction.prepareNewLiveValidation(fixture.context);

  fs.writeFileSync(
    path.join(fixture.targetPath, 'server.properties'),
    'motd=Changed During Health\nserver-port=25565\n'
  );

  await assert.rejects(
    transaction.completeNewLiveValidation(fixture.context, authorization),
    error => {
      assert.equal(error.code, 'HEALTH_CHECK_FAILED');
      return true;
    }
  );
});

test('new live completion rejects forged authorization for changed server properties', async (t) => {
  const transaction = require('../../electron/services/modpack-lifecycle/server-directory-transaction.cjs');
  const fixture = await newLiveFixture(t, 'forged-properties');
  const authorization = await transaction.prepareNewLiveValidation(fixture.context);
  const changedProperties = Buffer.from('motd=Forged Authorization\nserver-port=25565\n', 'utf8');
  fs.writeFileSync(path.join(fixture.targetPath, 'server.properties'), changedProperties);
  const forgedAuthorization = {
    ...authorization,
    properties: {
      bytes: changedProperties.toString('base64'),
      existed: true,
      sha256: crypto.createHash('sha256').update(changedProperties).digest('hex')
    }
  };

  await assert.rejects(
    transaction.completeNewLiveValidation(fixture.context, forgedAuthorization),
    error => {
      assert.equal(error.code, 'HEALTH_CHECK_FAILED');
      return true;
    }
  );
});

test('mutable new verifier accepts the journal-ahead failed-canonical rename split', async (t) => {
  const { OperationJournal } = require('../../electron/services/modpack-lifecycle/operation-journal.cjs');
  const transaction = require('../../electron/services/modpack-lifecycle/server-directory-transaction.cjs');
  const fixture = await newLiveFixture(t, 'journal-ahead-failed-rename');
  await transaction.prepareNewLiveValidation(fixture.context);
  let record = await fixture.recoveryRegistry.load(fixture.context.jobId);

  fs.mkdirSync(path.join(fixture.targetPath, 'world'));
  fs.writeFileSync(path.join(fixture.targetPath, 'world', 'level.dat'), 'mutated-before-failed-rename');
  fs.mkdirSync(path.join(fixture.targetPath, 'logs'));
  fs.writeFileSync(path.join(fixture.targetPath, 'logs', 'latest.log'), 'health failed\n');

  record = await fixture.recoveryRegistry.transition(fixture.context.jobId, {
    expectedPhase: 'validating-live',
    nextPhase: 'rolling-back',
    patch: { outcome: { ...record.outcome, failure: { code: 'HEALTH_CHECK_FAILED' } } }
  });
  const targetIdentity = record.directoryIdentities.target;
  const journal = new OperationJournal({
    durableFs: fixture.durableFs,
    fsApi: fs,
    clock: fixture.context.clock
  });
  const targetJournalPath = path.join(
    fixture.targetPath,
    '.minecraft-core-state',
    'operations',
    fixture.context.jobId,
    'journal.json'
  );
  await journal.transition(targetJournalPath, {
    expectedPhase: 'registered',
    nextPhase: 'rolling-back',
    patch: {
      swapStep: 'candidate-published',
      targetIdentity,
      failedIdentity: null
    }
  });
  fixture.durableFs.renameDurable(fixture.targetPath, fixture.paths.failedPath);
  const failedJournalPath = path.join(
    fixture.paths.failedPath,
    '.minecraft-core-state',
    'operations',
    fixture.context.jobId,
    'journal.json'
  );
  await journal.transition(failedJournalPath, {
    expectedPhase: 'rolling-back',
    nextPhase: 'rolling-back',
    patch: {
      swapStep: 'failed-canonical-moved',
      targetIdentity: null,
      failedIdentity: targetIdentity
    }
  });

  const owned = await transaction.verifyMutableNewOperationOwnedDirectory(
    fixture.context,
    fixture.paths.failedPath,
    targetIdentity
  );
  assert.equal(owned.journalRecord.phase, 'rolling-back');
  assert.equal(owned.journalRecord.swapStep, 'failed-canonical-moved');
  assert.deepEqual(owned.journalRecord.failedIdentity, targetIdentity);
  const registryBehind = await fixture.recoveryRegistry.load(fixture.context.jobId);
  assert.equal(registryBehind.phase, 'rolling-back');
  assert.equal(registryBehind.swapStep, 'candidate-published');
  assert.equal(registryBehind.directoryIdentities.failed, null);
});

test('failure between renames retains enough identity to restore one canonical server', async (t) => {
  const transaction = require('../../electron/services/modpack-lifecycle/server-directory-transaction.cjs');
  const fixture = await existingFixture(t);

  await transaction.buildExistingCandidate(fixture.context);
  fixture.fault.boundary = 'live-moved';
  await assert.rejects(
    transaction.swapExistingCandidate(fixture.context),
    error => error.code === 'COMMIT_FAILED' && error.existingSwapCallsite === 'live-moved-boundary' &&
      error.cause?.message === 'fault after live-moved'
  );

  const record = await fixture.recoveryRegistry.load(fixture.context.jobId);
  assert.equal(record.phase, 'committing');
  assert.equal(record.swapStep, 'live-moved');
  assert.equal(fs.existsSync(fixture.targetPath), false);
  assert.equal(fs.existsSync(fixture.paths.rollbackPath), true);
  assert.equal(fs.existsSync(fixture.paths.candidatePath), true);
  assert.deepEqual(record.directoryIdentities.rollback, record.directoryIdentities.target);
  assert.notDeepEqual(record.directoryIdentities.candidate, record.directoryIdentities.rollback);
});

// A server that never locks world/session.lock (pre-1.15) passes the live-folder probe, so the
// swap itself must refuse while that server still holds a file open inside the live folder.
test('existing swap fails closed and leaves the live folder intact while a file inside it is held open', {
  skip: process.platform !== 'win32' && 'Windows refuses directory renames over open files'
}, async (t) => {
  const transaction = require('../../electron/services/modpack-lifecycle/server-directory-transaction.cjs');
  const fixture = await existingFixture(t);
  await transaction.buildExistingCandidate(fixture.context);
  const prepared = await fixture.recoveryRegistry.load(fixture.context.jobId);
  assert.equal(prepared.swapStep, 'prepared');

  const heldPath = path.join(fixture.targetPath, 'world', 'level.dat');
  const held = fs.openSync(heldPath, 'r+');
  let closed = false;
  t.after(() => { if (!closed) fs.closeSync(held); });
  await assert.rejects(transaction.swapExistingCandidate(fixture.context), error => {
    assert.ok(['COMMIT_FAILED', 'RECOVERY_REQUIRED'].includes(error.code), error.code);
    const nativeCodes = [];
    for (let cause = error.cause; cause; cause = cause.cause) nativeCodes.push(cause.code);
    assert.ok(nativeCodes.some(code => ['EPERM', 'EBUSY', 'EACCES'].includes(code)), `refused by the open handle: ${nativeCodes}`);
    return true;
  });
  fs.closeSync(held);
  closed = true;

  assert.equal(fs.readFileSync(path.join(fixture.targetPath, 'server.jar'), 'utf8'), 'old-server');
  assert.equal(fs.readFileSync(heldPath, 'utf8'), 'world-state');
  assert.equal(fs.readFileSync(path.join(fixture.targetPath, 'server.properties'), 'utf8'), 'motd=Canonical\nserver-port=25565\n');
  assert.equal(fs.existsSync(path.join(fixture.targetPath, 'mods')), false, 'the candidate was never published over the live folder');
  assert.equal(fs.existsSync(fixture.paths.rollbackPath), false);
  assert.equal(fs.readFileSync(path.join(fixture.paths.candidatePath, 'server.jar'), 'utf8'), 'new-server');
  const record = await fixture.recoveryRegistry.load(fixture.context.jobId);
  assert.equal(record.phase, 'committing');
  assert.equal(record.swapStep, 'prepared');
  assert.deepEqual(record.directoryIdentities.target, prepared.directoryIdentities.target);
  assert.equal(record.directoryIdentities.rollback, null);
});

test('existing-server candidate preservation refuses server.properties larger than one MiB', async t => {
  const transaction = require('../../electron/services/modpack-lifecycle/server-directory-transaction.cjs');
  const fixture = await existingFixture(t, {
    validateCandidate: false,
    afterIncoming(candidatePath) {
      fs.writeFileSync(
        path.join(candidatePath, 'server.properties'),
        Buffer.alloc((1024 * 1024) + 1, 0x61)
      );
    }
  });

  await assert.rejects(
    transaction.buildExistingCandidate(fixture.context),
    error => error?.code === 'RECOVERY_REQUIRED'
  );
  assert.equal(fs.readFileSync(path.join(fixture.targetPath, 'server.properties'), 'utf8'),
    'motd=Canonical\nserver-port=25565\n');
});

test('the staging boundary atomically records the post-backup fingerprint and clears the published restore claim', async (t) => {
  const transaction = require('../../electron/services/modpack-lifecycle/server-directory-transaction.cjs');
  const fixture = await existingFixture(t, {
    authorizeForgeCandidateHealth: true,
    runtime: forgeRuntime,
    withPublishedRestoreCreation: true
  });
  const authorization = issueForgeCandidateHealthAuthorization({
    candidatePath: fixture.paths.candidatePath,
    instanceId: fixture.context.stableInstanceId,
    jobId: fixture.context.jobId,
    operationKind: fixture.context.operationKind,
    restorePointId: 'restore-existing',
    restorePointSha256: 'a'.repeat(64),
    runtime: fixture.context.runtime,
    serverPath: fixture.targetPath,
    sourceRevision: fixture.context.mutationLease.baseRevision
  });
  fixture.context.forgeCandidateHealthAuthorization = authorization;
  fixture.fault.boundary = 'staging-recorded';

  await assert.rejects(transaction.buildExistingCandidate(fixture.context), /fault after staging-recorded/);

  const record = await fixture.recoveryRegistry.load(fixture.context.jobId);
  assert.equal(record.phase, 'staging');
  assert.equal(record.restoreCreation, null);
  assert.match(record.outcome.live.fingerprint, /^[a-f0-9]{64}$/);
  assert.equal(fs.existsSync(fixture.paths.candidatePath), false);
});

test('existing candidate identity is durable before the live tree copy begins', async (t) => {
  const transaction = require('../../electron/services/modpack-lifecycle/server-directory-transaction.cjs');
  const { identifyServerDirectory, inspectServerDirectoryTree } = require(
    '../../electron/services/modpack-lifecycle/server-directory-identity.cjs'
  );
  const fixture = await existingFixture(t);
  fixture.fault.boundary = 'candidate-created';

  await assert.rejects(transaction.buildExistingCandidate(fixture.context), /fault after candidate-created/);

  const record = await fixture.recoveryRegistry.load(fixture.context.jobId);
  assert.equal(record.phase, 'staging');
  assert.deepEqual(record.directoryIdentities.target, (await inspectServerDirectoryTree(
    fixture.targetPath,
    { fsApi: fs, reparseInspector: fixture.context.reparseInspector }
  )).directoryIdentity);
  assert.deepEqual(
    record.directoryIdentities.candidate,
    (await identifyServerDirectory(fixture.paths.candidatePath, {
      fsApi: fs,
      reparseInspector: fixture.context.reparseInspector
    }))
  );
  assert.deepEqual(fs.readdirSync(fixture.paths.candidatePath), []);
});

test('existing candidate authorizes exact live-source evidence before creating its private candidate', async (t) => {
  const transaction = require('../../electron/services/modpack-lifecycle/server-directory-transaction.cjs');
  let fixture;
  let authorization = null;
  fixture = await existingFixture(t, {
    async authorizeSourceSnapshot(snapshot) {
      assert.equal(fs.existsSync(fixture.paths.candidatePath), false);
      await new Promise(resolve => setImmediate(resolve));
      authorization = snapshot;
      fixture.calls.push('source:authorized');
    }
  });

  await transaction.buildExistingCandidate(fixture.context);

  assert.equal(Object.isFrozen(authorization), true);
  assert.equal(authorization.entries.some(entry => entry.pathKey === 'server.jar' && entry.type === 'file'), true);
  assert.ok(fixture.calls.indexOf('source:authorized') < fixture.calls.indexOf('lease:dirty'));
  assert.ok(fixture.calls.indexOf('source:authorized') < fixture.calls.indexOf('incoming:apply'));
});

test('fresh rollback candidate also authorizes the exact live source before candidate creation', async (t) => {
  const transaction = require('../../electron/services/modpack-lifecycle/server-directory-transaction.cjs');
  let fixture;
  let calls = 0;
  fixture = await existingFixture(t, {
    freshCandidate: true,
    validateCandidate: false,
    async authorizeSourceSnapshot(snapshot) {
      calls += 1;
      assert.equal(fs.existsSync(fixture.paths.candidatePath), false);
      assert.equal(snapshot.entries.some(entry => entry.pathKey === 'world/level.dat'), true);
    }
  });

  await transaction.buildExistingCandidate(fixture.context);

  assert.equal(calls, 1);
});

function traceCandidateValidationDurability(fixture) {
  const events = [];
  const baseFsPromises = fixture.context.fsPromises || fixture.context.fsApi.promises || fs.promises;
  const baseReparseInspector = fixture.context.reparseInspector;
  const fsPromises = Object.create(baseFsPromises);
  const candidatePath = path.resolve(fixture.paths.candidatePath);
  const candidateRoot = `${candidatePath}${path.sep}`;
  let validationStarted = false;

  const writeCandidateState = fixture.context.stateRepository.writeCandidateAsync;
  fixture.context.stateRepository.writeCandidateAsync = async (...args) => {
    const result = await writeCandidateState(...args);
    validationStarted = true;
    events.push({ kind: 'state-written' });
    return result;
  };

  fsPromises.open = async (filePath, flags, ...args) => {
    const resolved = path.resolve(filePath);
    const handle = await baseFsPromises.open(filePath, flags, ...args);
    if (!validationStarted || (resolved !== candidatePath && !resolved.startsWith(candidateRoot))) return handle;
    const access = (flags & fs.constants.O_RDWR) === fs.constants.O_RDWR
      ? 'read-write'
      : ((flags & fs.constants.O_WRONLY) === fs.constants.O_WRONLY ? 'write-only' : 'read-only');
    events.push({ access, kind: 'open', path: resolved });
    return new Proxy(handle, {
      get(target, property) {
        if (property === 'sync') {
          return async () => {
            events.push({ kind: 'sync', path: resolved });
            return target.sync();
          };
        }
        const value = Reflect.get(target, property, target);
        return typeof value === 'function' ? value.bind(target) : value;
      }
    });
  };
  fixture.context.fsPromises = fsPromises;
  fixture.context.reparseInspector = {
    async isReparsePoint(candidate, options) {
      if (validationStarted) events.push({ kind: 'reparse', path: path.resolve(candidate) });
      return baseReparseInspector.isReparsePoint(candidate, options);
    }
  };
  return events;
}

test('existing candidate performs one combined hash and durability traversal only after candidate health', async (t) => {
  const transaction = require('../../electron/services/modpack-lifecycle/server-directory-transaction.cjs');
  const fixture = await existingFixture(t);
  const events = traceCandidateValidationDurability(fixture);
  const validateCandidate = fixture.context.healthValidator.validateCandidate;
  fixture.context.healthValidator.validateCandidate = async request => {
    events.push({ kind: 'health-start' });
    const result = await validateCandidate(request);
    events.push({ kind: 'health-end' });
    return result;
  };

  await transaction.buildExistingCandidate(fixture.context);

  const healthStart = events.findIndex(event => event.kind === 'health-start');
  const healthEnd = events.findIndex(event => event.kind === 'health-end');
  const readWriteOpens = events.filter(event => event.kind === 'open' && event.access === 'read-write');
  const syncs = events.filter(event => event.kind === 'sync');
  assert.ok(healthStart > 0);
  assert.ok(healthEnd > healthStart);
  assert.ok(readWriteOpens.length > 0);
  assert.equal(events.slice(0, healthStart).some(event =>
    event.kind === 'reparse' && event.path === path.resolve(fixture.paths.candidatePath, 'mods', 'pack.jar')), true);
  assert.equal(events.slice(0, healthEnd + 1).some(event => event.access === 'read-write' || event.kind === 'sync'), false);
  assert.equal(readWriteOpens.every(event => events.indexOf(event) > healthEnd), true);
  assert.equal(syncs.every(event => events.indexOf(event) > healthEnd), true);
  assert.equal(syncs.length, readWriteOpens.length);
  assert.equal(new Set(readWriteOpens.map(event => event.path)).size, readWriteOpens.length);
});

test('existing files-only candidate performs one combined hash and durability traversal after its safety scan', async (t) => {
  const transaction = require('../../electron/services/modpack-lifecycle/server-directory-transaction.cjs');
  const fixture = await existingFixture(t, { validateCandidate: false });
  const events = traceCandidateValidationDurability(fixture);
  fixture.context.onProgress = async event => {
    events.push({ kind: 'progress', percent: event.percent });
  };

  await transaction.buildExistingCandidate(fixture.context);

  const finalization = events.findIndex(event => event.kind === 'progress' && event.percent === 60);
  const readWriteOpens = events.filter(event => event.kind === 'open' && event.access === 'read-write');
  const syncs = events.filter(event => event.kind === 'sync');
  assert.ok(finalization > 0);
  assert.ok(readWriteOpens.length > 0);
  assert.equal(readWriteOpens.every(event => events.indexOf(event) > finalization), true);
  assert.equal(syncs.every(event => events.indexOf(event) > finalization), true);
  assert.equal(syncs.length, readWriteOpens.length);
  assert.equal(new Set(readWriteOpens.map(event => event.path)).size, readWriteOpens.length);
  assert.equal(events.some(event => event.kind === 'health-start'), false);
});

test('existing candidate reports monotonic lifecycle progress around copy, reconciliation, health, hashing, and flush work', async (t) => {
  const transaction = require('../../electron/services/modpack-lifecycle/server-directory-transaction.cjs');
  const fixture = await existingFixture(t);
  const progress = [];
  fixture.context.onProgress = async event => { progress.push(structuredClone(event)); };

  await transaction.buildExistingCandidate(fixture.context);

  assert.ok(progress.some(event => /^Copying server files \(\d+ of \d+ files, \d+ of \d+ B\)$/.test(event.message)));
  assert.ok(progress.some(event => event.message === 'Flushing copied server directories'));
  assert.ok(progress.some(event => event.message === 'Verifying the copied server files'));
  assert.deepEqual(progress.filter(event => event.percent !== 38 || event.message === 'Copying the live server into a protected candidate'), [
    { phase: 'staging', percent: 36, message: 'Checking the live server content', currentItem: null },
    { phase: 'staging', percent: 38, message: 'Copying the live server into a protected candidate', currentItem: null },
    { phase: 'staging', percent: 40, message: 'Live server copy verified', currentItem: null },
    { phase: 'staging', percent: 42, message: 'Reconciling reviewed modpack files', currentItem: null },
    { phase: 'validating-candidate', percent: 50, message: 'Recording the candidate state', currentItem: null },
    { phase: 'validating-candidate', percent: 53, message: 'Checking candidate filesystem safety', currentItem: null },
    { phase: 'validating-candidate', percent: 57, message: 'Boot-testing the candidate on loopback', currentItem: null },
    { phase: 'validating-candidate', percent: 60, message: 'Hashing and durably recording the validated candidate', currentItem: null },
    { phase: 'validating-candidate', percent: 62, message: 'Confirming the live server remained unchanged', currentItem: null },
    { phase: 'validating-candidate', percent: 63, message: 'Sealing candidate integrity evidence', currentItem: null }
  ]);
  assert.equal(progress.every((event, index) => index === 0 || event.percent >= progress[index - 1].percent), true);
  assert.equal(fixture.calls.includes('health:candidate'), true);
});

function setCopyCheckpointFiles(fixture, contents) {
  // Only replace the three known files in this test's disposable live tree.
  const properties = fs.readFileSync(path.join(fixture.targetPath, 'server.properties'));
  const applyIncoming = fixture.context.applyIncoming;
  fixture.context.applyIncoming = async request => {
    await applyIncoming(request);
    // Restore the health fixture's required properties after the measured copy.
    fs.writeFileSync(path.join(request.candidatePath, 'server.properties'), properties);
  };
  fs.unlinkSync(path.join(fixture.targetPath, 'server.jar'));
  fs.unlinkSync(path.join(fixture.targetPath, 'server.properties'));
  fs.unlinkSync(path.join(fixture.targetPath, 'world', 'level.dat'));
  fs.rmdirSync(path.join(fixture.targetPath, 'world'));
  contents.forEach((content, index) => {
    fs.writeFileSync(path.join(fixture.targetPath, `${String.fromCharCode(97 + index)}.txt`), content);
  });
}

async function attachCopyCheckpointStore(fixture) {
  const { OperationStore } = require('../../electron/services/modpack-lifecycle/operation-store.cjs');
  const userDataPath = path.join(path.dirname(path.dirname(fixture.targetPath)), 'progress-store');
  fs.mkdirSync(userDataPath);
  let replacements = 0;
  let temporary = 0;
  const durableClient = nativeDurability();
  const replace = durableClient.replaceFileWriteThroughAsync;
  durableClient.replaceFileWriteThroughAsync = async (...args) => {
    await replace(...args);
    replacements += 1;
  };
  const durableFs = createDurableFs({
    fsApi: fs,
    durableClient,
    allowedRoots: [userDataPath],
    tempNameFactory: () => `copy-checkpoint-${++temporary}`
  });
  const store = new OperationStore({ userDataPath, fsApi: fs, durableFs, clock: fixture.context.clock });
  await store.initialize();
  await store.create({
    jobId: fixture.context.jobId, operationKind: 'repair',
    serverId: fixture.context.stableInstanceId, planFingerprint: 'a'.repeat(64)
  });
  await store.transition(fixture.context.jobId, { expectedPhase: 'queued', nextPhase: 'preflight', patch: {} });
  await store.transition(fixture.context.jobId, { expectedPhase: 'preflight', nextPhase: 'staging', patch: {} });
  replacements = 0;
  fixture.context.onProgress = async event => {
    const { phase, ...progress } = event;
    const current = await store.get(fixture.context.jobId);
    if (current.phase === phase) {
      await store.updateProgress(fixture.context.jobId, { expectedPhase: phase, progress });
    } else {
      await store.transition(fixture.context.jobId, {
        expectedPhase: current.phase, nextPhase: phase, patch: { progress }
      });
    }
  };
  return { store, replacementCount: () => replacements };
}

test('copy checkpoints publish first, latest ten-second samples, and completion through the real transaction and store', async t => {
  const transaction = require('../../electron/services/modpack-lifecycle/server-directory-transaction.cjs');
  const fixture = await existingFixture(t);
  setCopyCheckpointFiles(fixture, ['a', 'bb', 'ccc', 'dddd', 'eeeee', 'ffffff']);
  const times = [0, 1, 9999, 10000, 10001, 20000, 20001];
  let sample = 0;
  let measuredAt = null;
  fixture.context.copyProgressClock = () => (measuredAt = times[sample++]);
  const publication = await attachCopyCheckpointStore(fixture);
  const publish = fixture.context.onProgress;
  const progress = [];
  fixture.context.onProgress = async event => {
    await publish(event);
    progress.push({ ...event, measuredAt });
  };

  await transaction.buildExistingCandidate(fixture.context);

  assert.deepEqual(progress.filter(event => event.message.startsWith('Copying server files ('))
    .map(({ measuredAt, message }) => ({ measuredAt, message })), [
    { measuredAt: 0, message: 'Copying server files (0 of 6 files, 0 of 21 B)' },
    { measuredAt: 10000, message: 'Copying server files (3 of 6 files, 6 of 21 B)' },
    { measuredAt: 20000, message: 'Copying server files (5 of 6 files, 15 of 21 B)' },
    { measuredAt: 20001, message: 'Copying server files (6 of 6 files, 21 of 21 B)' }
  ]);
  assert.equal(sample, 7);
  assert.equal(publication.replacementCount(), 16);
  assert.equal(progress.length, 16);
  assert.equal((await publication.store.get(fixture.context.jobId)).phase, 'validating-candidate');
  assert.equal((await fixture.recoveryRegistry.load(fixture.context.jobId)).phase, 'committing');
  assert.equal(fs.readFileSync(path.join(fixture.paths.candidatePath, 'f.txt'), 'utf8'), 'ffffff');
});

test('copy readable rounding never changes first, ten-second or final-file checkpoint admission', async t => {
  // Catches formatted text driving copy admission or byte equality being interpreted as terminal success.
  const transaction = require('../../electron/services/modpack-lifecycle/server-directory-transaction.cjs');
  const fixture = await existingFixture(t);
  setCopyCheckpointFiles(fixture, [Buffer.alloc(1), Buffer.alloc(1), Buffer.alloc(1), Buffer.alloc(1), Buffer.alloc(1), Buffer.alloc(2043)]);
  const times = [0, 1, 9999, 10000, 10001, 20000, 20001];
  let sample = 0;
  let measuredAt;
  fixture.context.copyProgressClock = () => (measuredAt = times[sample++]);
  const progress = [];
  fixture.context.onProgress = async event => { progress.push({ ...event, measuredAt }); };
  await transaction.buildExistingCandidate(fixture.context);
  assert.deepEqual(progress.filter(event => event.message.startsWith('Copying server files (')).map(event => [event.measuredAt, event.message]), [
    [0, 'Copying server files (0 of 6 files, 0 of 2 KiB (approx.))'],
    [10000, 'Copying server files (3 of 6 files, 0 of 2 KiB (approx.))'],
    [20000, 'Copying server files (5 of 6 files, 0 of 2 KiB (approx.))'],
    [20001, 'Copying server files (6 of 6 files, 2 of 2 KiB (approx.))']
  ]);
  assert.equal(sample, 7);
  assert.deepEqual((await fixture.recoveryRegistry.load(fixture.context.jobId)).outcome.copy, { bytes: '2048', files: 6 });
  assert.equal(progress.some(event => event.message === 'Live server copy verified'), true);
});

test('copy checkpoints retain quick and empty completion before immediate flush and verification milestones', async t => {
  const transaction = require('../../electron/services/modpack-lifecycle/server-directory-transaction.cjs');
  for (const { name, contents, counters } of [
    { name: 'quick', contents: ['abc', 'defgh'], counters: [
      'Copying server files (0 of 2 files, 0 of 8 B)',
      'Copying server files (2 of 2 files, 8 of 8 B)'
    ] },
    { name: 'empty', contents: [], counters: ['Copying server files (0 of 0 files, 0 of 0 B)'] }
  ]) {
    await t.test(name, async subtest => {
      const fixture = await existingFixture(subtest);
      setCopyCheckpointFiles(fixture, contents);
      fixture.context.copyProgressClock = () => 0;
      const progress = [];
      fixture.context.onProgress = async event => { progress.push(event); };

      await transaction.buildExistingCandidate(fixture.context);

      assert.deepEqual(progress.filter(event => event.percent === 38 || event.percent === 40)
        .map(event => event.message), [
        'Copying the live server into a protected candidate', ...counters,
        'Flushing copied server directories', 'Verifying the copied server files', 'Live server copy verified'
      ]);
      assert.equal((await fixture.recoveryRegistry.load(fixture.context.jobId)).phase, 'committing');
    });
  }
});

test('copy checkpoints cancel during suppressed real-copy samples without waiting or reaching commit', async t => {
  const transaction = require('../../electron/services/modpack-lifecycle/server-directory-transaction.cjs');
  const fixture = await existingFixture(t);
  setCopyCheckpointFiles(fixture, ['a', 'bb', 'ccc', 'dddd', 'eeeee', 'ffffff']);
  const abort = new AbortController();
  fixture.context.signal = abort.signal;
  const times = [0, 1, 9999];
  let sample = 0;
  fixture.context.copyProgressClock = () => {
    const now = times[sample++];
    if (sample === 3) abort.abort();
    return now;
  };
  const progress = [];
  fixture.context.onProgress = async event => { progress.push(event); };

  await assert.rejects(transaction.buildExistingCandidate(fixture.context), error => error.code === 'CANCELLED');

  assert.equal(sample, 3);
  assert.deepEqual(progress.filter(event => event.message.startsWith('Copying server files ('))
    .map(event => event.message), ['Copying server files (0 of 6 files, 0 of 21 B)']);
  assert.equal(fs.existsSync(path.join(fixture.paths.candidatePath, 'b.txt')), true);
  assert.equal(fs.existsSync(path.join(fixture.paths.candidatePath, 'c.txt')), false);
  assert.equal(fixture.calls.includes('incoming:apply'), false);
  assert.equal(fixture.calls.includes('boundary:live-copied'), false);
  assert.equal(fs.existsSync(fixture.paths.rollbackPath), false);
  const record = await fixture.recoveryRegistry.load(fixture.context.jobId);
  assert.equal(record.phase, 'staging');
  assert.equal(record.swapStep, 'none');
  assert.equal(fs.readFileSync(path.join(fixture.targetPath, 'f.txt'), 'utf8'), 'ffffff');
});

test('copy checkpoints treat observer errors as failed attempts without replay or lost completion', async t => {
  const transaction = require('../../electron/services/modpack-lifecycle/server-directory-transaction.cjs');
  const fixture = await existingFixture(t);
  setCopyCheckpointFiles(fixture, ['a', 'bb', 'ccc', 'dddd', 'eeeee', 'ffffff']);
  const times = [0, 1, 9999, 10000, 10001, 20000, 20001];
  let sample = 0;
  fixture.context.copyProgressClock = () => times[sample++];
  const attemptedCounters = [];
  fixture.context.onProgress = async event => {
    if (event.message.startsWith('Copying server files (')) {
      attemptedCounters.push(event.message);
      throw new Error('observational publication failed');
    }
  };

  await transaction.buildExistingCandidate(fixture.context);

  assert.deepEqual(attemptedCounters, [
    'Copying server files (0 of 6 files, 0 of 21 B)',
    'Copying server files (3 of 6 files, 6 of 21 B)',
    'Copying server files (5 of 6 files, 15 of 21 B)',
    'Copying server files (6 of 6 files, 21 of 21 B)'
  ]);
  assert.equal((await fixture.recoveryRegistry.load(fixture.context.jobId)).phase, 'committing');
});

test('copy checkpoints reject a non-function optional monotonic clock before transaction mutation', async t => {
  const transaction = require('../../electron/services/modpack-lifecycle/server-directory-transaction.cjs');
  const fixture = await existingFixture(t);
  fixture.context.copyProgressClock = 0;

  await assert.rejects(transaction.buildExistingCandidate(fixture.context), error => error.code === 'INVALID_REQUEST');

  assert.deepEqual(fixture.calls, []);
  assert.equal(fs.existsSync(fixture.paths.candidatePath), false);
  assert.equal((await fixture.recoveryRegistry.load(fixture.context.jobId)).phase, 'snapshotting');
});

test('existing candidate tree work cooperatively yields throughout copy, hash, and durability passes', async (t) => {
  const transaction = require('../../electron/services/modpack-lifecycle/server-directory-transaction.cjs');
  let yields = 0;
  let copyYieldObserved = false;
  let fixture;
  fixture = await existingFixture(t, {
    async yieldControl() {
      yields += 1;
      const candidatePath = fixture?.paths.candidatePath;
      if (candidatePath && fs.existsSync(path.join(candidatePath, 'server.jar')) &&
          !fs.existsSync(path.join(candidatePath, '.minecraft-core-state'))) {
        copyYieldObserved = true;
      }
      await new Promise(resolve => setImmediate(resolve));
    }
  });

  await transaction.buildExistingCandidate(fixture.context);

  assert.ok(yields >= 10);
  assert.equal(copyYieldObserved, true);
  assert.equal((await fixture.recoveryRegistry.load(fixture.context.jobId)).phase, 'committing');
});

function trackedNativeDurability(onCall) {
  return {
    capabilities: Object.freeze({
      moveWriteThroughFlushesParents: true,
      reconcileMoveWriteThrough: true
    }),
    moveWriteThrough(source, destination) { onCall('move'); fs.renameSync(source, destination); },
    async moveWriteThroughAsync(source, destination) {
      onCall('move');
      await new Promise(resolve => setImmediate(resolve));
      fs.renameSync(source, destination);
    },
    replaceFileWriteThrough(source, destination) { onCall('replace'); fs.renameSync(source, destination); },
    async replaceFileWriteThroughAsync(source, destination) {
      onCall('replace');
      await new Promise(resolve => setImmediate(resolve));
      fs.renameSync(source, destination);
    },
    reconcileMoveWriteThrough() { onCall('reconcile-move'); },
    flushDirectory() { onCall('flush-directory'); },
    flushDirectories() { onCall('flush-directories'); }
  };
}

test('new-server publication yields before secure durability launches can starve IPC', async (t) => {
  let consecutiveCalls = 0;
  let maximumConsecutiveCalls = 0;
  let currentCalls = [];
  let longestCalls = [];
  let durabilityHandoffs = 0;
  let cheapYields = 0;
  let tracking = false;
  const durableClient = trackedNativeDurability(label => {
    if (!tracking) return;
    consecutiveCalls += 1;
    currentCalls.push(label);
    if (consecutiveCalls > maximumConsecutiveCalls) {
      maximumConsecutiveCalls = consecutiveCalls;
      longestCalls = [...currentCalls];
    }
  });

  await newLiveFixture(t, 'durability-responsive', {
    durableClient,
    beforeBuild() {
      tracking = true;
      consecutiveCalls = 0;
      maximumConsecutiveCalls = 0;
      currentCalls = [];
      longestCalls = [];
    },
    async durabilityHandoff() {
      durabilityHandoffs += 1;
      consecutiveCalls = 0;
      currentCalls = [];
      await new Promise(resolve => setImmediate(resolve));
    },
    async yieldControl() {
      cheapYields += 1;
      await new Promise(resolve => setImmediate(resolve));
    }
  });

  assert.ok(durabilityHandoffs > 0);
  assert.ok(cheapYields > 0);
  assert.ok(maximumConsecutiveCalls <= 6,
    `observed ${maximumConsecutiveCalls} consecutive secure durability launches: ${longestCalls.join(', ')}`);
});

test('existing-server lifecycle and rollback cleanup keep secure durability launches bounded', async (t) => {
  const transaction = require('../../electron/services/modpack-lifecycle/server-directory-transaction.cjs');
  let consecutiveCalls = 0;
  let maximumConsecutiveCalls = 0;
  let currentCalls = [];
  let longestCalls = [];
  let durabilityHandoffs = 0;
  let cheapYields = 0;
  let tracking = false;
  const durableClient = trackedNativeDurability(label => {
    if (!tracking) return;
    consecutiveCalls += 1;
    currentCalls.push(label);
    if (consecutiveCalls > maximumConsecutiveCalls) {
      maximumConsecutiveCalls = consecutiveCalls;
      longestCalls = [...currentCalls];
    }
  });
  const fixture = await existingFixture(t, {
    durableClient,
    mutateCanonicalDuringLiveHealth: true,
    async durabilityHandoff() {
      durabilityHandoffs += 1;
      consecutiveCalls = 0;
      currentCalls = [];
      await new Promise(resolve => setImmediate(resolve));
    },
    async yieldControl() {
      cheapYields += 1;
      await new Promise(resolve => setImmediate(resolve));
    }
  });
  tracking = true;
  consecutiveCalls = 0;
  maximumConsecutiveCalls = 0;
  currentCalls = [];
  longestCalls = [];

  await transaction.buildExistingCandidate(fixture.context);
  await transaction.swapExistingCandidate(fixture.context);
  await transaction.markCommittedHealthy(fixture.context);
  await transaction.cleanupCommittedTransaction(fixture.context);

  assert.ok(durabilityHandoffs > 0);
  assert.ok(cheapYields > 0);
  assert.ok(maximumConsecutiveCalls <= 6,
    `observed ${maximumConsecutiveCalls} consecutive secure durability launches: ${longestCalls.join(', ')}`);
});

test('existing update uses real copies, validates both paths, publishes one revision, and cleans only after health', async (t) => {
  const transaction = require('../../electron/services/modpack-lifecycle/server-directory-transaction.cjs');
  const fixture = await existingFixture(t, {
    authorizeForgeCandidateHealth: true,
    runtime: forgeRuntime,
    withPublishedRestoreCreation: true
  });
  const liveWorld = fs.statSync(path.join(fixture.targetPath, 'world', 'level.dat'), { bigint: true });

  const built = await transaction.buildExistingCandidate(fixture.context);
  assert.equal(built.phase, 'committing');
  assert.equal(fixture.candidateHealthRequests.length, 1);
  assert.equal(
    fixture.candidateHealthRequests[0].forgeCandidateHealthAuthorization,
    fixture.forgeCandidateHealthAuthorization
  );
  assert.equal(fs.readFileSync(path.join(fixture.targetPath, 'server.jar'), 'utf8'), 'old-server');
  assert.equal(fs.readFileSync(path.join(fixture.paths.candidatePath, 'server.jar'), 'utf8'), 'new-server');
  assert.equal(fs.readFileSync(path.join(fixture.paths.candidatePath, 'world', 'level.dat'), 'utf8'), 'world-state');
  const candidateWorld = fs.statSync(path.join(fixture.paths.candidatePath, 'world', 'level.dat'), { bigint: true });
  assert.notEqual(candidateWorld.ino, liveWorld.ino);
  assert.equal(candidateWorld.nlink, 1n);

  const prepared = await fixture.recoveryRegistry.load(fixture.context.jobId);
  assert.equal(prepared.phase, 'committing');
  assert.equal(prepared.swapStep, 'prepared');
  assert.equal(prepared.restoreCreation, null);
  assert.equal(prepared.outcome.revision.source, 5);
  assert.equal(prepared.outcome.revision.target, 6);
  assert.equal(prepared.outcome.runtime.networkAccess, 'pack-default');
  assert.equal(prepared.outcome.runtime.port, 25565);

  const swapped = await transaction.swapExistingCandidate(fixture.context);
  assert.equal(swapped.phase, 'starting');
  assert.equal(fs.readFileSync(path.join(fixture.targetPath, 'server.jar'), 'utf8'), 'new-server');
  assert.equal(fs.readFileSync(path.join(fixture.paths.rollbackPath, 'server.jar'), 'utf8'), 'old-server');
  assert.equal(fs.readFileSync(path.join(fixture.paths.rollbackPath, 'world', 'level.dat'), 'utf8'), 'world-state');

  const healthy = await transaction.markCommittedHealthy(fixture.context);
  assert.equal(healthy.phase, 'committed-healthy');
  assert.equal(healthy.revision, 6);
  assert.equal(fixture.liveHealthRequests.length, 1);
  assert.equal(Object.hasOwn(fixture.liveHealthRequests[0], 'forgeCandidateHealthAuthorization'), false);
  await transaction.markCommittedHealthy(fixture.context);
  assert.equal(fixture.calls.filter(call => call.startsWith('revision:')).length, 1);
  assert.equal(fixture.calls.filter(call => call === 'health:live').length, 1);

  const cleaned = await transaction.cleanupCommittedTransaction(fixture.context);
  assert.deepEqual(cleaned, { phase: 'completed', rollbackRemoved: true });
  assert.equal(fs.existsSync(fixture.paths.rollbackPath), false);
  assert.equal(fs.existsSync(fixture.targetPath), true);
  const completed = await fixture.recoveryRegistry.load(fixture.context.jobId);
  assert.equal(completed.phase, 'completed');
  assert.equal(completed.swapStep, 'cleanup-complete');
  assert.equal(completed.outcome.cleanup.rollbackRemoved, true);
});

test('unmanaged adoption clones, commits, and health-validates a nonempty server while preserving its properties and world', async (t) => {
  const transaction = require('../../electron/services/modpack-lifecycle/server-directory-transaction.cjs');
  const fixture = await existingFixture(t, {
    unmanagedAdoption: true,
    operationKind: 'install',
    baseRevision: 0,
    targetRevision: 1
  });

  const built = await transaction.buildExistingCandidate(fixture.context);
  assert.equal(built.phase, 'committing');
  assert.equal(fs.readFileSync(path.join(fixture.paths.candidatePath, 'server.properties'), 'utf8'),
    'motd=Canonical\nserver-port=25565\n');
  assert.equal(fs.readFileSync(path.join(fixture.paths.candidatePath, 'world', 'level.dat'), 'utf8'), 'world-state');
  assert.equal(fs.readFileSync(path.join(fixture.paths.candidatePath, 'mods', 'pack.jar'), 'utf8'), 'pack-mod');

  await transaction.swapExistingCandidate(fixture.context);
  const healthy = await transaction.markCommittedHealthy(fixture.context);

  assert.equal(healthy.phase, 'committed-healthy');
  assert.equal(healthy.revision, 1);
  assert.equal(fixture.calls.filter(call => call === 'health:candidate').length, 1);
  assert.equal(fixture.calls.filter(call => call === 'health:live').length, 1);
  assert.equal(fs.readFileSync(path.join(fixture.targetPath, 'server.properties'), 'utf8'),
    'motd=Canonical\nserver-port=25565\n');
  assert.equal(fs.readFileSync(path.join(fixture.targetPath, 'world', 'level.dat'), 'utf8'), 'world-state');
  assert.equal(fs.readFileSync(path.join(fixture.paths.rollbackPath, 'server.properties'), 'utf8'),
    'motd=Canonical\nserver-port=25565\n');

  assert.deepEqual(await transaction.cleanupCommittedTransaction(fixture.context), {
    phase: 'completed', rollbackRemoved: true
  });
});

test('unmanaged adoption accepts an inactive lifecycle record without treating its old manifest as managed authority', async (t) => {
  const transaction = require('../../electron/services/modpack-lifecycle/server-directory-transaction.cjs');
  const fixture = await existingFixture(t, {
    unmanagedAdoption: true,
    unmanagedCurrentState: {
      state: { modpackManaged: false, contentRevision: 4, runtime },
      manifest: { schemaVersion: 1, installationId: 'detached-old-pack', entries: [] }
    },
    operationKind: 'install',
    baseRevision: 4,
    targetRevision: 5
  });

  await transaction.buildExistingCandidate(fixture.context);

  const prepared = await fixture.recoveryRegistry.load(fixture.context.jobId);
  assert.deepEqual(prepared.outcome.revision, { source: 4, target: 5 });
  assert.deepEqual(prepared.outcome.runtime.source, runtime);
  assert.equal(fs.readFileSync(path.join(fixture.paths.candidatePath, 'world', 'level.dat'), 'utf8'), 'world-state');
  assert.equal(fs.readFileSync(path.join(fixture.paths.candidatePath, 'mods', 'pack.jar'), 'utf8'), 'pack-mod');
});

test('unmanaged adoption restores the exact original nonempty server after committed live health fails', async (t) => {
  const { ModpackRecoveryService } = require('../../electron/services/modpack-lifecycle/modpack-recovery-service.cjs');
  const { ServerMutationCoordinator } = require('../../electron/services/server-mutation-coordinator.cjs');
  const transaction = require('../../electron/services/modpack-lifecycle/server-directory-transaction.cjs');
  const healthFailure = Object.assign(new Error('adopted candidate failed live health'), {
    code: 'HEALTH_CHECK_FAILED'
  });
  const fixture = await existingFixture(t, {
    unmanagedAdoption: true,
    operationKind: 'install',
    baseRevision: 0,
    targetRevision: 1,
    priorAutoRestart: false,
    liveHealthError: healthFailure
  });

  await transaction.buildExistingCandidate(fixture.context);
  await transaction.swapExistingCandidate(fixture.context);
  await assert.rejects(transaction.markCommittedHealthy(fixture.context), error => error === healthFailure);
  assert.equal(fs.readFileSync(path.join(fixture.targetPath, 'server.jar'), 'utf8'), 'new-server');
  assert.equal(fs.readFileSync(path.join(fixture.paths.rollbackPath, 'server.jar'), 'utf8'), 'old-server');

  const runtimePolicy = {
    async suspend() { return { held: true }; },
    async ensureStopped() { return { stopped: true }; },
    async adoptValidatedHandoff() { return { adopted: true }; },
    async restoreAutoRestart() { return { restored: true }; }
  };
  // Stopped retention requires an authentic nested no-launch reservation. A
  // shape-only lifecycle lease cannot supply that coordinator exclusion.
  const coordinator = new ServerMutationCoordinator({ readContentRevision: () => 0,
    bumpContentRevision() { assert.fail('stopped rollback must not publish a content revision'); } });
  const selector = { instanceId: fixture.context.stableInstanceId, serverPath: fixture.targetPath };
  coordinator.installRecoveryBlocks([{ selector, operationId: fixture.context.jobId }]);
  coordinator.completeStartupRecovery([{ selector, resolved: false }]);
  const recoveryService = new ModpackRecoveryService({
    coordinator,
    recoveryRegistry: fixture.recoveryRegistry,
    runtimeWriterAuthority: { async assertRecoveryAllowed(record) { return record; } },
    contextFactory: async ({ mutationLease }) => ({
      ...fixture.context,
      mutationLease,
      runtimePolicy
    }),
    runtimePolicy
  });
  const record = await fixture.recoveryRegistry.load(fixture.context.jobId);
  const recovered = await coordinator.runRecoveryMutation(selector, { operationId: record.jobId }, lease =>
    recoveryService.rollbackWithLease(record, lease, 'adoption-live-health-failed'));

  assert.equal(recovered.resolved, true);
  assert.equal(recovered.action, 'rollback-restored');
  assert.equal(fs.readFileSync(path.join(fixture.targetPath, 'server.jar'), 'utf8'), 'old-server');
  assert.equal(fs.readFileSync(path.join(fixture.targetPath, 'server.properties'), 'utf8'),
    'motd=Canonical\nserver-port=25565\n');
  assert.equal(fs.readFileSync(path.join(fixture.targetPath, 'world', 'level.dat'), 'utf8'), 'world-state');
  assert.equal(fs.existsSync(fixture.paths.rollbackPath), false);
  assert.equal(fs.readFileSync(path.join(fixture.paths.failedPath, 'server.jar'), 'utf8'), 'new-server');
});

test('unmanaged adoption rollback resumes a previously running server from its registered runtime config', async (t) => {
  const { ModpackRecoveryService } = require('../../electron/services/modpack-lifecycle/modpack-recovery-service.cjs');
  const transaction = require('../../electron/services/modpack-lifecycle/server-directory-transaction.cjs');
  const healthFailure = Object.assign(new Error('adopted candidate failed its first live health check'), {
    code: 'HEALTH_CHECK_FAILED'
  });
  const fixture = await existingFixture(t, {
    unmanagedAdoption: true,
    operationKind: 'install',
    baseRevision: 0,
    targetRevision: 1,
    priorRunning: true,
    priorAutoRestart: true,
    liveHealthError: healthFailure
  });

  await transaction.buildExistingCandidate(fixture.context);
  await transaction.swapExistingCandidate(fixture.context);
  await assert.rejects(transaction.markCommittedHealthy(fixture.context), error => error === healthFailure);

  const recoveryCalls = [];
  fixture.context.healthValidator.validateLive = async request => {
    recoveryCalls.push('health:source');
    assert.equal(request.keepRunning, true);
    assert.deepEqual(request.runtime, runtime);
    assert.equal(request.maxRam, 8);
    assert.equal(request.port, 25565);
    return Object.freeze({
      evidence: Object.freeze({ kind: 'restored-source' }),
      handoff: Object.freeze({ processHandle: {}, startLease: {} })
    });
  };
  const runtimePolicy = {
    async suspend() { return { held: true }; },
    async ensureStopped() { recoveryCalls.push('runtime:stopped'); return { stopped: true }; },
    async adoptValidatedHandoff(request) {
      recoveryCalls.push('runtime:adopted');
      assert.deepEqual(request.runtime, runtime);
      return { adopted: true };
    },
    async restoreAutoRestart({ enabled }) {
      recoveryCalls.push(`auto-restart:${enabled}`);
      return { restored: true };
    }
  };
  const recoveryService = new ModpackRecoveryService({
    coordinator: { async runRecoveryMutation() { throw new Error('the held lifecycle lease must be reused'); } },
    recoveryRegistry: fixture.recoveryRegistry,
    runtimeWriterAuthority: { async assertRecoveryAllowed(record) { return record; } },
    contextFactory: async ({ mutationLease }) => ({
      ...fixture.context,
      mutationLease,
      runtimePolicy,
      async resolveRecoveryRuntimeConfig({ authority }) {
        recoveryCalls.push(`runtime-config:${authority}`);
        assert.equal(authority, 'source');
        return { runtime, maxRam: 8, port: 25565 };
      }
    }),
    runtimePolicy
  });
  const record = await fixture.recoveryRegistry.load(fixture.context.jobId);
  const recovered = await recoveryService.rollbackWithLease(
    record,
    fixture.context.mutationLease,
    'adoption-live-health-failed-running'
  );

  assert.equal(recovered.resolved, true);
  assert.equal(recovered.action, 'rollback-restored');
  assert.equal(fs.readFileSync(path.join(fixture.targetPath, 'server.jar'), 'utf8'), 'old-server');
  assert.equal(fs.readFileSync(path.join(fixture.targetPath, 'world', 'level.dat'), 'utf8'), 'world-state');
  assert.deepEqual(recoveryCalls, [
    'runtime:stopped',
    'runtime:stopped',
    'runtime:stopped',
    'runtime-config:source',
    'health:source',
    'runtime:adopted',
    'auto-restart:true'
  ]);
});

test('existing rollback records the coordinator revision when ordinary server writes occurred after the managed revision', async (t) => {
  const transaction = require('../../electron/services/modpack-lifecycle/server-directory-transaction.cjs');
  const fixture = await existingFixture(t, {
    operationKind: 'rollback',
    freshCandidate: true,
    validateCandidate: false,
    sourceRevision: 5,
    baseRevision: 8,
    targetRevision: 9
  });

  const built = await transaction.buildExistingCandidate(fixture.context);

  assert.equal(built.phase, 'committing');
  assert.equal(fixture.candidateHealthRequests.length, 0);
  const prepared = await fixture.recoveryRegistry.load(fixture.context.jobId);
  assert.deepEqual(prepared.outcome.revision, { source: 8, target: 9 });
  assert.equal(
    JSON.parse(fs.readFileSync(path.join(fixture.paths.candidatePath, '.minecraft-core.json'), 'utf8')).contentRevision,
    9
  );
});

test('fresh rollback candidate never inherits live bytes and still completes the exact two-rename transaction', async (t) => {
  const transaction = require('../../electron/services/modpack-lifecycle/server-directory-transaction.cjs');
  const fixture = await existingFixture(t, {
    operationKind: 'rollback',
    freshCandidate: true,
    async assertFreshCandidate(candidatePath) {
      assert.equal(fs.existsSync(path.join(candidatePath, 'server.jar')), false);
      assert.equal(fs.existsSync(path.join(candidatePath, 'server.properties')), false);
      assert.equal(fs.existsSync(path.join(candidatePath, 'world')), false);
      assert.equal(fs.existsSync(path.join(candidatePath, 'live-only.txt')), false);
    },
    async afterIncoming(candidatePath) {
      fs.writeFileSync(path.join(candidatePath, 'server.properties'), 'motd=Canonical\nserver-port=25565\n');
      fs.mkdirSync(path.join(candidatePath, 'world'));
      fs.writeFileSync(path.join(candidatePath, 'world', 'level.dat'), 'restored-world-state');
      fs.writeFileSync(path.join(candidatePath, 'restored-only.txt'), 'selected-restore');
    }
  });
  fs.writeFileSync(path.join(fixture.targetPath, 'live-only.txt'), 'must-not-overlay-selected-restore');

  const built = await transaction.buildExistingCandidate(fixture.context);
  assert.equal(built.phase, 'committing');
  const prepared = await fixture.recoveryRegistry.load(fixture.context.jobId);
  assert.deepEqual(prepared.outcome.copy, { bytes: '0', files: '0' });
  assert.equal(fs.existsSync(path.join(fixture.paths.candidatePath, 'live-only.txt')), false);
  assert.equal(fs.readFileSync(path.join(fixture.paths.candidatePath, 'restored-only.txt'), 'utf8'), 'selected-restore');
  assert.equal(fs.readFileSync(path.join(fixture.targetPath, 'live-only.txt'), 'utf8'),
    'must-not-overlay-selected-restore');

  await transaction.swapExistingCandidate(fixture.context);
  assert.equal(fs.existsSync(path.join(fixture.targetPath, 'live-only.txt')), false);
  assert.equal(fs.readFileSync(path.join(fixture.targetPath, 'world', 'level.dat'), 'utf8'), 'restored-world-state');
  assert.equal(fs.readFileSync(path.join(fixture.paths.rollbackPath, 'live-only.txt'), 'utf8'),
    'must-not-overlay-selected-restore');
  await transaction.markCommittedHealthy(fixture.context);
  await transaction.cleanupCommittedTransaction(fixture.context);
  assert.equal(fs.existsSync(fixture.paths.rollbackPath), false);
  assert.equal((await fixture.recoveryRegistry.load(fixture.context.jobId)).phase, 'completed');
});

test('existing install honors the reviewed start-after-install target policy even when the server was stopped', async (t) => {
  const transaction = require('../../electron/services/modpack-lifecycle/server-directory-transaction.cjs');
  const fixture = await existingFixture(t, { priorRunning: false, targetRunning: true });

  await transaction.buildExistingCandidate(fixture.context);
  await transaction.swapExistingCandidate(fixture.context);
  const healthy = await transaction.markCommittedHealthy(fixture.context);

  assert.equal(healthy.handoffExpected, true);
  assert.equal(fixture.calls.filter(call => call === 'health:live').length, 1);
  assert.equal(fixture.calls.filter(call => call.startsWith('handoff:')).length, 1);
});

test('managed uninstall can persist an inactive files-only state without requiring candidate runtime validation', async (t) => {
  const transaction = require('../../electron/services/modpack-lifecycle/server-directory-transaction.cjs');
  const fixture = await existingFixture(t, {
    operationKind: 'uninstall',
    validateCandidate: false,
    persistCandidateState({ candidatePath }) {
      fs.writeFileSync(path.join(candidatePath, '.minecraft-core-state', 'modpack.json'), JSON.stringify({
        modpackManaged: false, lifecycleMode: 'uninstalled', contentRevision: 6
      }));
      return { state: { contentRevision: 6 } };
    }
  });

  const built = await transaction.buildExistingCandidate(fixture.context);

  assert.equal(built.phase, 'committing');
  assert.equal(fixture.calls.includes('health:candidate'), false);
  assert.equal(
    JSON.parse(fs.readFileSync(path.join(fixture.paths.candidatePath, '.minecraft-core-state', 'modpack.json'))).lifecycleMode,
    'uninstalled'
  );
  await transaction.swapExistingCandidate(fixture.context);
  const healthy = await transaction.markCommittedHealthy({ ...fixture.context, validateLive: false });
  assert.equal(healthy.handoffExpected, false);
  assert.equal(fixture.calls.includes('health:live'), false);
  assert.deepEqual(await transaction.cleanupCommittedTransaction(fixture.context), {
    phase: 'completed', rollbackRemoved: true
  });
});

test('candidate health or exact properties restoration failure leaves the original live tree untouched', async (t) => {
  await t.test('health failure', async (subtest) => {
    const transaction = require('../../electron/services/modpack-lifecycle/server-directory-transaction.cjs');
    const failure = Object.assign(new Error('candidate unhealthy'), { code: 'HEALTH_CHECK_FAILED' });
    const fixture = await existingFixture(subtest, { candidateHealthError: failure });
    await assert.rejects(transaction.buildExistingCandidate(fixture.context), error => error === failure);
    assert.equal(fs.readFileSync(path.join(fixture.targetPath, 'server.jar'), 'utf8'), 'old-server');
    assert.equal(fs.existsSync(fixture.paths.rollbackPath), false);
    assert.equal((await fixture.recoveryRegistry.load(fixture.context.jobId)).phase, 'validating-candidate');
  });

  await t.test('properties not restored', async (subtest) => {
    const transaction = require('../../electron/services/modpack-lifecycle/server-directory-transaction.cjs');
    const fixture = await existingFixture(subtest, { mutatePropertiesDuringCandidateHealth: true });
    await assert.rejects(
      transaction.buildExistingCandidate(fixture.context),
      error => error && error.code === 'HEALTH_CHECK_FAILED'
    );
    assert.equal(
      fs.readFileSync(path.join(fixture.targetPath, 'server.properties'), 'utf8'),
      'motd=Canonical\nserver-port=25565\n'
    );
    assert.equal(fs.existsSync(fixture.paths.rollbackPath), false);
  });
});

test('canonical properties verification rejects synchronous content reads and yields through an async file handle', async (t) => {
  const transaction = require('../../electron/services/modpack-lifecycle/server-directory-transaction.cjs');
  const fixture = await existingFixture(t);
  const fsApi = Object.create(fs);
  fsApi.readFileSync = () => {
    throw new Error('synchronous canonical properties reads must not run');
  };
  let afterCandidateHealth = false;
  let responsiveReads = 0;
  const originalValidateCandidate = fixture.context.healthValidator.validateCandidate;
  fixture.context.healthValidator = {
    ...fixture.context.healthValidator,
    async validateCandidate(request) {
      const result = await originalValidateCandidate(request);
      afterCandidateHealth = true;
      return result;
    }
  };
  const fsPromises = Object.create(fs.promises);
  fsPromises.open = async (filePath, ...args) => {
    const handle = await fs.promises.open(filePath, ...args);
    if (!afterCandidateHealth || path.basename(filePath) !== 'server.properties') return handle;
    return new Proxy(handle, {
      get(target, property) {
        if (property === 'read') {
          return async (...readArgs) => {
            await new Promise(resolve => setImmediate(() => {
              responsiveReads += 1;
              resolve();
            }));
            return target.read(...readArgs);
          };
        }
        const value = Reflect.get(target, property, target);
        return typeof value === 'function' ? value.bind(target) : value;
      }
    });
  };
  fixture.context.fsApi = fsApi;
  fixture.context.fsPromises = fsPromises;

  const built = await transaction.buildExistingCandidate(fixture.context);

  assert.equal(built.phase, 'committing');
  assert.ok(responsiveReads > 0, 'canonical properties verification never yielded through an async read');
  assert.equal(fs.existsSync(fixture.targetPath), true);
  assert.equal(fs.existsSync(fixture.paths.rollbackPath), false);
});

// Removing a snapshot guard annotation must lose the independently expected
// bounded diagnostic below, without changing the transaction's rejection.
function snapshotStatDouble(stat, overrides = {}) {
  return new Proxy(stat, {
    get(target, key) {
      if (Object.hasOwn(overrides, key)) return overrides[key];
      const value = Reflect.get(target, key, target);
      return typeof value === 'function' ? value.bind(target) : value;
    }
  });
}

async function snapshotDiagnosticFixture(t, fault = {}) {
  const fixture = await existingFixture(t);
  let armed = false, pathStats = 0, handleStats = 0, probes = 0, reads = 0;
  const validate = fixture.context.healthValidator.validateCandidate;
  fixture.context.healthValidator.validateCandidate = async request => {
    const result = await validate(request);
    if (fault.health) await fault.health(request);
    armed = true;
    return result;
  };
  const isProperties = filePath => armed && filePath === path.join(fixture.paths.candidatePath, 'server.properties');
  const fsPromises = Object.create(fs.promises);
  fsPromises.lstat = async (filePath, ...args) => {
    const stat = await fs.promises.lstat(filePath, ...args);
    if (!isProperties(filePath)) return stat;
    pathStats++;
    return fault.pathStat ? fault.pathStat(stat, pathStats) : stat;
  };
  fsPromises.open = async (filePath, ...args) => {
    if (isProperties(filePath) && fault.openError) throw fault.openError;
    const handle = await fs.promises.open(filePath, ...args);
    if (!isProperties(filePath)) return handle;
    return new Proxy(handle, {
      get(target, key) {
        if (key === 'stat') return async (...statArgs) => {
          const stat = await target.stat(...statArgs);
          handleStats++;
          return fault.handleStat ? fault.handleStat(stat, handleStats) : stat;
        };
        if (key === 'read') return async (...readArgs) => {
          reads++;
          return fault.read ? fault.read(target, readArgs, reads) : target.read(...readArgs);
        };
        const value = Reflect.get(target, key, target);
        return typeof value === 'function' ? value.bind(target) : value;
      }
    });
  };
  fixture.context.fsPromises = fsPromises;
  fixture.context.reparseInspector = { async isReparsePoint(filePath) {
    if (!isProperties(filePath)) return false;
    probes++;
    return fault.probe ? fault.probe(probes) : false;
  } };
  return fixture;
}

const snapshotGuardCases = [
  ['initial-type', 'invalid-input', { pathStat: (s, n) => n === 1 ? snapshotStatDouble(s, { isFile: () => false }) : s }],
  ['initial-symlink', 'invalid-input', { pathStat: (s, n) => n === 1 ? snapshotStatDouble(s, { isSymbolicLink: () => true }) : s }],
  ['initial-links', 'invalid-input', { pathStat: (s, n) => n === 1 ? snapshotStatDouble(s, { nlink: 2n }) : s }],
  ['initial-size', 'limit', { pathStat: (s, n) => n === 1 ? snapshotStatDouble(s, { size: 1048577n }) : s }],
  ['initial-reparse', 'protocol', { probe: n => n === 1 ? { unexpected: true } : false }],
  ['opened-identity', 'identity-changed', { handleStat: (s, n) => n === 1 ? snapshotStatDouble(s, { mtimeNs: s.mtimeNs + 1n }) : s }, 32],
  ['opened-type', 'invalid-input', { handleStat: (s, n) => n === 1 ? snapshotStatDouble(s, { isFile: () => false }) : s }],
  ['opened-symlink', 'invalid-input', { handleStat: (s, n) => n === 1 ? snapshotStatDouble(s, { isSymbolicLink: () => true }) : s }],
  ['read-count', 'protocol', { read: async () => ({ bytesRead: -1 }) }],
  ['read-count', 'protocol', { read: async () => ({ bytesRead: 1.5 }) }],
  ['read-count', 'protocol', { read: async () => ({ bytesRead: 1048577 }) }],
  ['read-count', 'protocol', { read: async () => undefined }],
  ['accumulated-size', 'limit', { read: async (_h, args) => ({ bytesRead: args[2] }) }],
  ['post-path-missing', 'identity-changed', { pathStat: (s, n) => { if (n === 2) throw Object.assign(new Error('private'), { code: 'ENOENT' }); return s; } }],
  ['post-handle-identity', 'identity-changed', { handleStat: (s, n) => n === 2 ? snapshotStatDouble(s, { mtimeNs: s.mtimeNs + 1n }) : s }, 32],
  ['post-path-identity', 'identity-changed', { pathStat: (s, n) => n === 2 ? snapshotStatDouble(s, { birthtimeNs: s.birthtimeNs + 1n }) : s }, 128],
  ['byte-count', 'protocol', { read: async () => ({ bytesRead: 0 }) }],
  ['final-reparse', 'protocol', { probe: n => n === 2 ? true : false }],
  ['final-path-missing', 'identity-changed', { pathStat: (s, n) => { if (n === 3) throw Object.assign(new Error('private'), { code: 'ENOENT' }); return s; } }],
  ['final-identity', 'identity-changed', { pathStat: (s, n) => n === 3 ? snapshotStatDouble(s, { nlink: 2n, dev: s.dev + 1n, ino: s.ino + 1n, size: s.size + 1n,
    mtimeNs: s.mtimeNs + 1n, ctimeNs: s.ctimeNs + 1n, birthtimeNs: s.birthtimeNs + 1n, mode: s.mode + 1n }) : s }, 247]
];
for (const [index, [stage, reason, fault, mask]] of snapshotGuardCases.entries()) test(`exact snapshot diagnostic guard ${stage} (${index})`, async t => {
  const fixture = await snapshotDiagnosticFixture(t, fault);
  await assert.rejects(require('../../electron/services/modpack-lifecycle/server-directory-transaction.cjs').buildExistingCandidate(fixture.context), error => {
    assert.equal(error.code, 'RECOVERY_REQUIRED');
    assert.equal(error.message, 'The server publication requires recovery');
    assert.deepEqual(error.runtimeDiagnostic, { stage: `exact-snapshot-${stage}`, reason,
      ...(mask === undefined ? {} : { changedIdentityFields: mask }) });
    return true;
  });
  assert.equal(fs.readFileSync(path.join(fixture.targetPath, 'server.jar'), 'utf8'), 'old-server');
  assert.equal(fs.existsSync(fixture.paths.rollbackPath), false);
});

// Reinstating ctime as an identity guard must reject these real transactions.
// One-nanosecond offsets deliberately disappear under Number conversion.
for (const [boundary, pathCall, handleCall] of [
  ['opened handle', null, 1],
  ['post-read handle', null, 2],
  ['post-read path', 2, null],
  ['final path', 3, null]
]) test(`exact properties snapshot accepts ctime-only drift at ${boundary}`, async t => {
  const ctime = 1800000000000000000n;
  assert.equal(Number(ctime), Number(ctime + 1n));
  let changed = 0;
  const statAt = (stat, call, target) => {
    const drift = call === target ? 1n : 0n;
    if (drift) changed++;
    return snapshotStatDouble(stat, { ctimeNs: ctime + drift });
  };
  const fixture = await snapshotDiagnosticFixture(t, {
    pathStat: (stat, call) => statAt(stat, call, pathCall),
    handleStat: (stat, call) => statAt(stat, call, handleCall)
  });

  const built = await require('../../electron/services/modpack-lifecycle/server-directory-transaction.cjs')
    .buildExistingCandidate(fixture.context);

  assert.equal(built.phase, 'committing');
  assert.equal(changed, 1);
  for (const directory of [fixture.targetPath, fixture.paths.candidatePath]) {
    assert.equal(fs.readFileSync(path.join(directory, 'server.properties'), 'utf8'),
      'motd=Canonical\nserver-port=25565\n');
    assert.equal(fs.readFileSync(path.join(directory, 'world', 'level.dat'), 'utf8'), 'world-state');
  }
  assert.equal(fs.readFileSync(path.join(fixture.targetPath, 'server.jar'), 'utf8'), 'old-server');
  assert.equal(fs.readFileSync(path.join(fixture.paths.candidatePath, 'server.jar'), 'utf8'), 'new-server');
  assert.equal(fs.existsSync(fixture.paths.rollbackPath), false);
});

test('exact properties snapshot accepts a real metadata-only readonly change after health', async t => {
  let properties, originalMode, metadataChanged = false, restoredAtProgress = false;
  const fixture = await snapshotDiagnosticFixture(t, {
    probe: call => {
      if (call !== 1) return false;
      properties = path.join(fixture.paths.candidatePath, 'server.properties');
      const before = fs.lstatSync(properties, { bigint: true });
      originalMode = Number(before.mode);
      const bytes = fs.readFileSync(properties);
      fs.chmodSync(properties, 0o444);
      const after = fs.lstatSync(properties, { bigint: true });
      assert.notEqual(after.mode, before.mode);
      for (const field of ['dev', 'ino', 'birthtimeNs', 'size', 'mtimeNs', 'nlink']) {
        assert.equal(after[field], before[field], field);
      }
      assert.deepEqual(fs.readFileSync(properties), bytes);
      metadataChanged = true;
      t.diagnostic(`readonly change observed ctimeNs delta: ${after.ctimeNs - before.ctimeNs}ns (not required)`);
      return false;
    }
  });
  fixture.context.onProgress = async progress => {
    if (progress.percent !== 60) return;
    assert.equal(metadataChanged, true);
    fs.chmodSync(properties, originalMode);
    assert.equal(Number(fs.lstatSync(properties, { bigint: true }).mode), originalMode);
    restoredAtProgress = true;
  };

  try {
    const built = await require('../../electron/services/modpack-lifecycle/server-directory-transaction.cjs')
      .buildExistingCandidate(fixture.context);
    assert.equal(built.phase, 'committing');
    assert.equal(metadataChanged, true);
    assert.equal(restoredAtProgress, true);
    for (const directory of [fixture.targetPath, fixture.paths.candidatePath]) {
      assert.equal(fs.readFileSync(path.join(directory, 'server.properties'), 'utf8'),
        'motd=Canonical\nserver-port=25565\n');
    }
    assert.equal(fs.readFileSync(path.join(fixture.targetPath, 'server.jar'), 'utf8'), 'old-server');
    assert.equal(fs.existsSync(fixture.paths.rollbackPath), false);
  } finally {
    if (originalMode !== undefined) fs.chmodSync(properties, originalMode);
  }
});

test('exact properties snapshot rejects same-size changed bytes with restored mtime and ctime drift', async t => {
  let changedProperties;
  const fixture = await snapshotDiagnosticFixture(t, {
    health: async ({ candidatePath }) => {
      const properties = path.join(candidatePath, 'server.properties');
      const before = fs.lstatSync(properties, { bigint: true });
      const canonical = fs.readFileSync(properties);
      changedProperties = Buffer.from('motd=Different\nserver-port=25565\n');
      assert.equal(changedProperties.length, canonical.length);
      fs.writeFileSync(properties, changedProperties);
      assert.equal(before.mtimeNs, 1800000000000000000n);
      fs.utimesSync(properties, Number(before.atimeNs) / 1e9, 1800000000);
      const after = fs.lstatSync(properties, { bigint: true });
      for (const field of ['dev', 'ino', 'birthtimeNs', 'size', 'mtimeNs', 'nlink']) {
        assert.equal(after[field], before[field], field);
      }
    },
    pathStat: (stat, call) => snapshotStatDouble(stat, {
      ctimeNs: 1800000000000000000n + BigInt(call)
    }),
    handleStat: stat => snapshotStatDouble(stat, {
      ctimeNs: 1800000000000000001n
    })
  });
  const applyIncoming = fixture.context.applyIncoming;
  fixture.context.applyIncoming = async request => {
    await applyIncoming(request);
    // An integral-second timestamp can be restored exactly by real utimes.
    fs.utimesSync(path.join(request.candidatePath, 'server.properties'), 1800000000, 1800000000);
  };
  await assert.rejects(require('../../electron/services/modpack-lifecycle/server-directory-transaction.cjs')
    .buildExistingCandidate(fixture.context), error => {
    assert.equal(error.code, 'HEALTH_CHECK_FAILED');
    assert.deepEqual(error.runtimeDiagnostic, { stage: 'exact-snapshot-bytes', reason: 'digest-mismatch' });
    return true;
  });
  assert.deepEqual(fs.readFileSync(path.join(fixture.paths.candidatePath, 'server.properties')), changedProperties);
  assert.equal(fs.readFileSync(path.join(fixture.targetPath, 'server.properties'), 'utf8'),
    'motd=Canonical\nserver-port=25565\n');
  assert.equal(fs.readFileSync(path.join(fixture.targetPath, 'server.jar'), 'utf8'), 'old-server');
  assert.equal(fs.readFileSync(path.join(fixture.targetPath, 'world', 'level.dat'), 'utf8'), 'world-state');
  assert.equal(fs.existsSync(fixture.paths.rollbackPath), false);
});

test('exact snapshot diagnostic I/O failures preserve original identity and existing more-specific diagnostics', async t => {
  const ioCases = [
    ['initial-stat', error => ({ pathStat: (_s, n) => { if (n === 1) throw error; return _s; } })],
    ['open', error => ({ openError: error })],
    ['opened-stat', error => ({ handleStat: (_s, n) => { if (n === 1) throw error; return _s; } })],
    ['read', error => ({ read: async () => { throw error; } })],
    ['post-handle-stat', error => ({ handleStat: (_s, n) => { if (n === 2) throw error; return _s; } })],
    ['post-path-stat', error => ({ pathStat: (_s, n) => { if (n === 2) throw error; return _s; } })],
    ['final-stat', error => ({ pathStat: (_s, n) => { if (n === 3) throw error; return _s; } })],
    ['initial-reparse', error => ({ probe: n => { if (n === 1) throw error; return false; } })],
    ['final-reparse', error => ({ probe: n => { if (n === 2) throw error; return false; } })]
  ];
  const { retainRuntimeWorkerQuiescence, waitForRuntimeWorkerQuiescence } = require('../../electron/services/runtime-worker-quiescence.cjs');
  for (const [stage, inject] of ioCases) await t.test(stage, async subtest => {
    const failure = Object.assign(new Error('C:\\private\\properties raw failure'), { code: 'EACCES' });
    retainRuntimeWorkerQuiescence(failure, Promise.resolve(true));
    const fixture = await snapshotDiagnosticFixture(subtest, inject(failure));
    const rejected = await require('../../electron/services/modpack-lifecycle/server-directory-transaction.cjs').buildExistingCandidate(fixture.context).then(
      () => assert.fail('snapshot I/O failure must reject'), error => error);
    assert.equal(rejected, failure);
    await waitForRuntimeWorkerQuiescence(rejected);
    assert.deepEqual(rejected.runtimeDiagnostic, { stage: `exact-snapshot-${stage}`, reason: 'io', osCode: 'EACCES' });
  });
  const failure = Object.assign(new Error('private probe'), { runtimeDiagnostic: { stage: 'reparse-native-tag', reason: 'protocol' } });
  const fixture = await snapshotDiagnosticFixture(t, { probe: () => { throw failure; } });
  await assert.rejects(require('../../electron/services/modpack-lifecycle/server-directory-transaction.cjs').buildExistingCandidate(fixture.context), error => {
    assert.equal(error, failure);
    assert.deepEqual(error.runtimeDiagnostic, { stage: 'reparse-native-tag', reason: 'protocol' });
    return true;
  });
});

test('exact snapshot diagnostic distinguishes health await, stable bytes mismatch and progress 60 rejection', async t => {
  const transaction = require('../../electron/services/modpack-lifecycle/server-directory-transaction.cjs');
  await t.test('health await', async subtest => {
    const failure = new Error('private health failure');
    Object.defineProperty(failure, 'candidateBootDiagnostic', { value: { stage: 'candidate-boot', boundary: 'readiness', category: 'health-failure' } });
    const fixture = await existingFixture(subtest, { candidateHealthError: failure });
    await assert.rejects(transaction.buildExistingCandidate(fixture.context), error => {
      assert.equal(error, failure);
      assert.deepEqual(error.runtimeDiagnostic, { stage: 'candidate-health-call', reason: 'unknown' });
      assert.equal(error.candidateBootDiagnostic.boundary, 'readiness');
      return true;
    });
  });
  await t.test('stable changed bytes', async subtest => {
    const fixture = await existingFixture(subtest, { mutatePropertiesDuringCandidateHealth: true });
    await assert.rejects(transaction.buildExistingCandidate(fixture.context), error => {
      assert.equal(error.code, 'HEALTH_CHECK_FAILED');
      assert.deepEqual(error.runtimeDiagnostic, { stage: 'exact-snapshot-bytes', reason: 'digest-mismatch' });
      return true;
    });
    assert.equal(fs.readFileSync(path.join(fixture.targetPath, 'server.properties'), 'utf8'),
      'motd=Canonical\nserver-port=25565\n');
    assert.equal(fs.readFileSync(path.join(fixture.targetPath, 'server.jar'), 'utf8'), 'old-server');
    assert.equal(fs.readFileSync(path.join(fixture.targetPath, 'world', 'level.dat'), 'utf8'), 'world-state');
    assert.equal(fs.existsSync(fixture.paths.rollbackPath), false);
  });
  await t.test('progress 60', async subtest => {
    const failure = new Error('private progress failure');
    const fixture = await existingFixture(subtest);
    fixture.context.onProgress = async progress => { if (progress.percent === 60) throw failure; };
    await assert.rejects(transaction.buildExistingCandidate(fixture.context), error => {
      assert.equal(error, failure);
      assert.deepEqual(error.runtimeDiagnostic, { stage: 'candidate-progress-60', reason: 'unknown' });
      return true;
    });
  });
});

test('exact snapshot diagnostic leaves overlay/restore successful but rejects within-read nanosecond mutation', async t => {
  const transaction = require('../../electron/services/modpack-lifecycle/server-directory-transaction.cjs');
  const fixture = await snapshotDiagnosticFixture(t, { health: async ({ candidatePath }) => {
    const properties = path.join(candidatePath, 'server.properties');
    const bytes = fs.readFileSync(properties);
    fs.writeFileSync(properties, 'server-port=25566\n');
    fs.writeFileSync(properties, bytes);
  } });
  assert.equal((await transaction.buildExistingCandidate(fixture.context)).phase, 'committing');
  let changed = false;
  const mutation = await snapshotDiagnosticFixture(t, {
    read: async (handle, args) => { const result = await handle.read(...args); if (result.bytesRead) changed = true; return result; },
    handleStat: (s, n) => n === 2 && changed ? snapshotStatDouble(s, { mtimeNs: s.mtimeNs + 1n }) : s
  });
  await assert.rejects(transaction.buildExistingCandidate(mutation.context), error => {
    assert.deepEqual(error.runtimeDiagnostic, { stage: 'exact-snapshot-post-handle-identity', reason: 'identity-changed', changedIdentityFields: 32 });
    return true;
  });
});

test('exact snapshot diagnostic annotation never masks frozen or accessor-bearing original failures', async t => {
  let reads = 0;
  const accessor = new Error('private accessor');
  Object.defineProperty(accessor, 'runtimeDiagnostic', { get() { reads++; throw new Error('must not run'); } });
  for (const failure of [Object.freeze(new Error('private frozen')), accessor]) {
    const fixture = await snapshotDiagnosticFixture(t, { openError: failure });
    await assert.rejects(require('../../electron/services/modpack-lifecycle/server-directory-transaction.cjs').buildExistingCandidate(fixture.context), error => error === failure);
  }
  assert.equal(reads, 0);
});

test('exact snapshot diagnostic preserves candidate cancellation and mode-only snapshot acceptance', async t => {
  const transaction = require('../../electron/services/modpack-lifecycle/server-directory-transaction.cjs');
  const cancellation = Object.assign(new Error('cancelled'), { code: 'CANCELLED' });
  const health = await existingFixture(t, { candidateHealthError: cancellation });
  await assert.rejects(transaction.buildExistingCandidate(health.context), error => error === cancellation && error.code === 'CANCELLED');
  const controller = new AbortController();
  const reading = await snapshotDiagnosticFixture(t, { read: async (handle, args) => {
    const result = await handle.read(...args);
    if (result.bytesRead) controller.abort();
    return result;
  } });
  reading.context.signal = controller.signal;
  await assert.rejects(transaction.buildExistingCandidate(reading.context), error => error.code === 'CANCELLED');
  assert.equal(fs.existsSync(reading.paths.rollbackPath), false);
  assert.equal(fs.readFileSync(path.join(reading.targetPath, 'server.jar'), 'utf8'), 'old-server');
  const modeOnly = await snapshotDiagnosticFixture(t, { handleStat: (s, n) => n === 2 ? snapshotStatDouble(s, { mode: s.mode + 1n }) : s });
  assert.equal((await transaction.buildExistingCandidate(modeOnly.context)).phase, 'committing');
});

test('links, hardlinks, reparse entries, and sibling aliases fail before the original live path moves', async (t) => {
  await t.test('hardlink', async (subtest) => {
    const transaction = require('../../electron/services/modpack-lifecycle/server-directory-transaction.cjs');
    const fixture = await existingFixture(subtest);
    fs.linkSync(
      path.join(fixture.targetPath, 'server.jar'),
      path.join(fixture.targetPath, 'server-copy.jar')
    );
    await assert.rejects(
      transaction.buildExistingCandidate(fixture.context),
      error => error && error.code === 'UNSAFE_ARCHIVE_ENTRY'
    );
    assert.equal(fs.existsSync(fixture.targetPath), true);
  });

  await t.test('reparse', async (subtest) => {
    const transaction = require('../../electron/services/modpack-lifecycle/server-directory-transaction.cjs');
    const fixture = await existingFixture(subtest);
    fixture.context.reparseInspector = {
      async isReparsePoint(candidate) { return candidate.endsWith('level.dat'); }
    };
    await assert.rejects(
      transaction.buildExistingCandidate(fixture.context),
      error => error && error.code === 'UNSAFE_ARCHIVE_ENTRY'
    );
    assert.equal(fs.existsSync(fixture.targetPath), true);
  });

  await t.test('rollback alias', async (subtest) => {
    const transaction = require('../../electron/services/modpack-lifecycle/server-directory-transaction.cjs');
    const fixture = await existingFixture(subtest);
    fs.mkdirSync(fixture.paths.rollbackPath);
    await assert.rejects(
      transaction.buildExistingCandidate(fixture.context),
      error => error && error.code === 'TARGET_EXISTS'
    );
    assert.equal(fs.readFileSync(path.join(fixture.targetPath, 'server.jar'), 'utf8'), 'old-server');
  });

  await t.test('junction or symlink when permitted', async (subtest) => {
    const transaction = require('../../electron/services/modpack-lifecycle/server-directory-transaction.cjs');
    const fixture = await existingFixture(subtest);
    const link = path.join(fixture.targetPath, 'linked-world');
    try {
      fs.symlinkSync(path.join(fixture.targetPath, 'world'), link, 'junction');
    } catch (error) {
      if (['EPERM', 'EACCES', 'UNKNOWN'].includes(error?.code)) return;
      throw error;
    }
    await assert.rejects(
      transaction.buildExistingCandidate(fixture.context),
      error => error && error.code === 'UNSAFE_ARCHIVE_ENTRY'
    );
    assert.equal(fs.existsSync(fixture.targetPath), true);
  });
});

test('target, candidate, and rollback content substitutions are rejected by identity and fingerprint', async (t) => {
  await t.test('target identity replacement', async (subtest) => {
    const transaction = require('../../electron/services/modpack-lifecycle/server-directory-transaction.cjs');
    const fixture = await existingFixture(subtest);
    await transaction.buildExistingCandidate(fixture.context);
    const unrelated = `${fixture.targetPath}-unrelated`;
    fs.renameSync(fixture.targetPath, `${fixture.targetPath}-original`);
    fs.mkdirSync(unrelated);
    fs.renameSync(unrelated, fixture.targetPath);
    await assert.rejects(
      transaction.swapExistingCandidate(fixture.context),
      error => error && error.code === 'RECOVERY_REQUIRED'
    );
    assert.equal(fs.existsSync(fixture.paths.rollbackPath), false);
  });

  await t.test('candidate content mutation', async (subtest) => {
    const transaction = require('../../electron/services/modpack-lifecycle/server-directory-transaction.cjs');
    const fixture = await existingFixture(subtest);
    await transaction.buildExistingCandidate(fixture.context);
    fs.writeFileSync(path.join(fixture.paths.candidatePath, 'server.jar'), 'tampered');
    await assert.rejects(
      transaction.swapExistingCandidate(fixture.context),
      error => error && error.code === 'RECOVERY_REQUIRED'
    );
    assert.equal(fs.existsSync(fixture.targetPath), true);
  });

  await t.test('rollback content mutation', async (subtest) => {
    const transaction = require('../../electron/services/modpack-lifecycle/server-directory-transaction.cjs');
    const fixture = await existingFixture(subtest);
    await transaction.buildExistingCandidate(fixture.context);
    await transaction.swapExistingCandidate(fixture.context);
    fs.writeFileSync(path.join(fixture.paths.rollbackPath, 'server.jar'), 'tampered rollback');
    await assert.rejects(
      transaction.markCommittedHealthy(fixture.context),
      error => error && error.code === 'RECOVERY_REQUIRED'
    );
    assert.equal((await fixture.recoveryRegistry.load(fixture.context.jobId)).phase, 'starting');
  });
});

test('source mutation during copy and a different-volume candidate fail closed', async (t) => {
  await t.test('source mutation during copy', async (subtest) => {
    const transaction = require('../../electron/services/modpack-lifecycle/server-directory-transaction.cjs');
    const fixture = await existingFixture(subtest);
    let armed = false;
    let mutated = false;
    const baseBoundary = fixture.context.afterBoundary;
    fixture.context.afterBoundary = async name => {
      if (name === 'candidate-created') armed = true;
      await baseBoundary(name);
    };
    const fsPromises = Object.create(fs.promises);
    fsPromises.open = async (...args) => {
      const handle = await fs.promises.open(...args);
      return new Proxy(handle, {
        get(target, property) {
          if (property === 'read') {
            return async (...readArgs) => {
              if (armed && !mutated) {
                mutated = true;
                fs.appendFileSync(path.join(fixture.targetPath, 'server.jar'), '-external-mutation');
              }
              return target.read(...readArgs);
            };
          }
          const value = Reflect.get(target, property, target);
          return typeof value === 'function' ? value.bind(target) : value;
        }
      });
    };
    fixture.context.fsPromises = fsPromises;
    await assert.rejects(
      transaction.buildExistingCandidate(fixture.context),
      error => error && ['RECOVERY_REQUIRED', 'UNSAFE_ARCHIVE_ENTRY'].includes(error.code)
    );
    assert.equal(mutated, true);
    assert.equal(fs.existsSync(fixture.paths.rollbackPath), false);
    assert.equal(fs.existsSync(fixture.targetPath), true);
  });

  await t.test('different volume identity', async (subtest) => {
    const transaction = require('../../electron/services/modpack-lifecycle/server-directory-transaction.cjs');
    const fixture = await existingFixture(subtest);
    const fsPromises = Object.create(fs.promises);
    fsPromises.lstat = async (candidate, options) => {
      const stat = await fs.promises.lstat(candidate, options);
      if (!stat || path.resolve(candidate) !== path.resolve(fixture.paths.candidatePath)) return stat;
      return new Proxy(stat, {
        get(target, property) {
          if (property === 'dev') return target.dev + 1n;
          const value = Reflect.get(target, property, target);
          return typeof value === 'function' ? value.bind(target) : value;
        }
      });
    };
    fixture.context.fsPromises = fsPromises;
    await assert.rejects(
      transaction.buildExistingCandidate(fixture.context),
      error => error && error.code === 'COMMIT_FAILED'
    );
    assert.equal(fs.existsSync(fixture.paths.rollbackPath), false);
    assert.equal(fs.existsSync(fixture.targetPath), true);
  });
});

test('rename and split registry-journal failures remain reconstructable without adopting unrelated paths', async (t) => {
  await t.test('first rename failure leaves live authoritative', async (subtest) => {
    const transaction = require('../../electron/services/modpack-lifecycle/server-directory-transaction.cjs');
    const fixture = await existingFixture(subtest);
    await transaction.buildExistingCandidate(fixture.context);
    const base = fixture.context.durableFs;
    const wrapped = {
      ...base,
      async renameDurableAsync() { throw Object.assign(new Error('rename blocked'), { code: 'COMMIT_FAILED' }); }
    };
    fixture.context.durableFs = wrapped;
    fixture.recoveryRegistry.durableFs = wrapped;
    await assert.rejects(transaction.swapExistingCandidate(fixture.context));
    assert.equal(fs.existsSync(fixture.targetPath), true);
    assert.equal(fs.existsSync(fixture.paths.candidatePath), true);
    assert.equal(fs.existsSync(fixture.paths.rollbackPath), false);
    assert.equal((await fixture.recoveryRegistry.load(fixture.context.jobId)).swapStep, 'prepared');
  });

  await t.test('second rename failure leaves durable live-moved evidence', async (subtest) => {
    const transaction = require('../../electron/services/modpack-lifecycle/server-directory-transaction.cjs');
    const fixture = await existingFixture(subtest);
    await transaction.buildExistingCandidate(fixture.context);
    const base = fixture.context.durableFs;
    let renames = 0;
    const wrapped = {
      ...base,
      async renameDurableAsync(...args) {
        renames += 1;
        if (renames === 2) throw Object.assign(new Error('second rename blocked'), { code: 'COMMIT_FAILED' });
        return base.renameDurableAsync(...args);
      }
    };
    fixture.context.durableFs = wrapped;
    fixture.recoveryRegistry.durableFs = wrapped;
    await assert.rejects(transaction.swapExistingCandidate(fixture.context));
    assert.equal(fs.existsSync(fixture.targetPath), false);
    assert.equal(fs.existsSync(fixture.paths.candidatePath), true);
    assert.equal(fs.existsSync(fixture.paths.rollbackPath), true);
    assert.equal((await fixture.recoveryRegistry.load(fixture.context.jobId)).swapStep, 'live-moved');
  });

  await t.test('journal failure after registry live-moved remains discoverable', async (subtest) => {
    const transaction = require('../../electron/services/modpack-lifecycle/server-directory-transaction.cjs');
    const fixture = await existingFixture(subtest);
    await transaction.buildExistingCandidate(fixture.context);
    const base = fixture.context.durableFs;
    const candidateJournal = path.join(
      fixture.paths.candidatePath,
      '.minecraft-core-state',
      'operations',
      fixture.context.jobId,
      'journal.json'
    );
    const wrapped = {
      ...base,
      async writeJsonAtomicAsync(filePath, value, options) {
        if (path.resolve(filePath) === path.resolve(candidateJournal) && value.swapStep === 'live-moved') {
          throw Object.assign(new Error('journal blocked'), { code: 'COMMIT_FAILED' });
        }
        return base.writeJsonAtomicAsync(filePath, value, options);
      }
    };
    fixture.context.durableFs = wrapped;
    fixture.recoveryRegistry.durableFs = wrapped;
    await assert.rejects(transaction.swapExistingCandidate(fixture.context));
    const record = await fixture.recoveryRegistry.load(fixture.context.jobId);
    assert.equal(record.swapStep, 'live-moved');
    assert.equal(fs.existsSync(fixture.targetPath), false);
    assert.equal(fs.existsSync(fixture.paths.rollbackPath), true);
    assert.equal(fs.existsSync(fixture.paths.candidatePath), true);
  });
});

test('live boundary diagnostics request bounded boot evidence on the real live validation call', async t => {
  const transaction = require('../../electron/services/modpack-lifecycle/server-directory-transaction.cjs');
  const fixture = await existingFixture(t);
  await transaction.buildExistingCandidate(fixture.context);
  await transaction.swapExistingCandidate(fixture.context);
  const result = await transaction.markCommittedHealthy(fixture.context);
  assert.equal(result.phase, 'committed-healthy');
  assert.equal(fixture.liveHealthRequests.length, 1);
  assert.equal(fixture.liveHealthRequests[0].captureBootDiagnostic, true);
});

test('live boundary diagnostics tag raw health and healthy-publication failures without losing exact close proof', async t => {
  const transaction = require('../../electron/services/modpack-lifecycle/server-directory-transaction.cjs');
  const { retainRuntimeWorkerQuiescence, waitForRuntimeWorkerQuiescence } = require('../../electron/services/runtime-worker-quiescence.cjs');
  for (const stage of ['live-health-call', 'live-health-publication']) await t.test(stage, async subtest => {
    const failure = new Error('private C:\\server\\publication failure');
    let close;
    retainRuntimeWorkerQuiescence(failure, new Promise(resolve => { close = resolve; }));
    const fixture = await existingFixture(subtest, stage === 'live-health-call' ? { liveHealthError: failure } : {});
    await transaction.buildExistingCandidate(fixture.context);
    await transaction.swapExistingCandidate(fixture.context);
    if (stage === 'live-health-publication') {
      const transition = fixture.recoveryRegistry.transition.bind(fixture.recoveryRegistry);
      fixture.recoveryRegistry.transition = async (jobId, request) => {
        if (request.expectedPhase === 'validating-live' && request.nextPhase === 'committed-healthy') throw failure;
        return transition(jobId, request);
      };
    }
    await assert.rejects(transaction.markCommittedHealthy(fixture.context), error => {
      assert.equal(error, failure);
      assert.deepEqual(error.runtimeDiagnostic, { stage, reason: 'unknown' });
      return true;
    });
    let settled = false;
    const proof = waitForRuntimeWorkerQuiescence(failure).then(() => { settled = true; });
    await new Promise(resolve => setImmediate(resolve));
    assert.equal(settled, false);
    close(true);
    await proof;
    assert.equal(fixture.liveHealthRequests[0].captureBootDiagnostic, true);
    assert.equal((await fixture.recoveryRegistry.load(fixture.context.jobId)).phase, 'validating-live');
    assert.equal(fs.readFileSync(path.join(fixture.targetPath, 'server.jar'), 'utf8'), 'new-server');
    assert.equal(fs.readFileSync(path.join(fixture.paths.rollbackPath, 'server.jar'), 'utf8'), 'old-server');
  });
});

test('live boundary diagnostics preserve exact snapshot identity metadata through properties cleanup', async t => {
  const transaction = require('../../electron/services/modpack-lifecycle/server-directory-transaction.cjs');
  const fixture = await existingFixture(t);
  await transaction.buildExistingCandidate(fixture.context);
  await transaction.swapExistingCandidate(fixture.context);
  const fsPromises = Object.create(fs.promises);
  fsPromises.open = async (filePath, ...args) => {
    const handle = await fs.promises.open(filePath, ...args);
    if (!fixture.liveHealthRequests.length || filePath !== path.join(fixture.targetPath, 'server.properties')) return handle;
    let stats = 0;
    return new Proxy(handle, { get(target, key) {
      if (key === 'stat') return async (...statArgs) => {
        const stat = await target.stat(...statArgs);
        return ++stats === 2 ? snapshotStatDouble(stat, { mtimeNs: stat.mtimeNs + 1n }) : stat;
      };
      const value = Reflect.get(target, key, target);
      return typeof value === 'function' ? value.bind(target) : value;
    } });
  };
  fixture.context.fsPromises = fsPromises;
  await assert.rejects(transaction.markCommittedHealthy(fixture.context), error => {
    assert.deepEqual(error.runtimeDiagnostic, {
      stage: 'exact-snapshot-post-handle-identity', reason: 'identity-changed', changedIdentityFields: 32
    });
    return true;
  });
  assert.equal((await fixture.recoveryRegistry.load(fixture.context.jobId)).phase, 'validating-live');
});

test('prior running policy adopts the exact validated handoff before healthy commit', async (t) => {
  const transaction = require('../../electron/services/modpack-lifecycle/server-directory-transaction.cjs');
  const fixture = await existingFixture(t, { priorRunning: true });
  await transaction.buildExistingCandidate(fixture.context);
  await transaction.swapExistingCandidate(fixture.context);
  await transaction.markCommittedHealthy(fixture.context);
  assert.equal(fixture.calls.filter(call => call.startsWith('handoff:')).length, 1);
  const record = await fixture.recoveryRegistry.load(fixture.context.jobId);
  assert.equal(record.outcome.runtimePolicy.runningRestored, true);
  assert.equal(record.priorRuntime.running, true);
});

test('existing running update stops its exact retained health process when handoff adoption fails', async (t) => {
  const transaction = require('../../electron/services/modpack-lifecycle/server-directory-transaction.cjs');
  const adoptionError = new Error('injected existing-server adoption failure');
  let live = true;
  let stopCalls = 0;
  const processHandle = {
    closed: Promise.resolve({ exitCode: 0, signal: null }),
    isLive() { return live; },
    async stopFully() {
      stopCalls += 1;
      live = false;
      return { clean: true, closed: true, exitCode: 0, forced: false, signal: null };
    }
  };
  const fixture = await existingFixture(t, {
    priorRunning: true,
    adoptionError,
    liveHandoff: Object.freeze({ processHandle, startLease: {} })
  });
  await transaction.buildExistingCandidate(fixture.context);
  await transaction.swapExistingCandidate(fixture.context);

  await assert.rejects(transaction.markCommittedHealthy(fixture.context), error => {
    assert.equal(error, adoptionError);
    assert.deepEqual(error.runtimeDiagnostic, { stage: 'live-handoff', reason: 'unknown' });
    return true;
  });

  assert.equal(stopCalls, 1);
  assert.equal(live, false);
  assert.equal((await fixture.recoveryRegistry.load(fixture.context.jobId)).phase, 'validating-live');
});

test('existing running update fails closed when an unadopted health process cannot be proven stopped', async (t) => {
  const { isUnprovenHealthProcessError } = require('../../electron/services/server-health-validator.cjs');
  const transaction = require('../../electron/services/modpack-lifecycle/server-directory-transaction.cjs');
  let stopCalls = 0;
  const processHandle = {
    closed: Promise.resolve({ exitCode: null, signal: null }),
    isLive() { return true; },
    async stopFully() {
      stopCalls += 1;
      throw new Error('injected stop failure');
    }
  };
  const fixture = await existingFixture(t, {
    priorRunning: true,
    adoptionResult: { adopted: false },
    liveHandoff: Object.freeze({ processHandle, startLease: {} })
  });
  await transaction.buildExistingCandidate(fixture.context);
  await transaction.swapExistingCandidate(fixture.context);

  await assert.rejects(transaction.markCommittedHealthy(fixture.context), error => {
    assert.equal(error.code, 'HEALTH_CHECK_FAILED');
    assert.equal(isUnprovenHealthProcessError(error), true);
    return true;
  });

  assert.equal(stopCalls, 1);
  assert.equal((await fixture.recoveryRegistry.load(fixture.context.jobId)).phase, 'validating-live');
});

for (const closes of [true, false]) {
  test(`existing running update ${closes ? 'stops its retained process' : 'marks its retained process unproven'} when post-health properties inspection fails`, async (t) => {
    const { isUnprovenHealthProcessError } = require('../../electron/services/server-health-validator.cjs');
    const transaction = require('../../electron/services/modpack-lifecycle/server-directory-transaction.cjs');
    const inspectionError = new Error('injected post-health properties read failure');
    let live = true;
    let stopCalls = 0;
    let resolveClosed;
    const processHandle = {
      closed: new Promise(resolve => { resolveClosed = resolve; }),
      isLive() { return live; },
      async stopFully() {
        stopCalls += 1;
        const result = { clean: closes, closed: closes, exitCode: closes ? 0 : null, forced: false, signal: null };
        if (closes) {
          live = false;
          resolveClosed(result);
        }
        return result;
      }
    };
    const fixture = await existingFixture(t, {
      priorRunning: true,
      liveHandoff: Object.freeze({ processHandle, startLease: {} })
    });
    await transaction.buildExistingCandidate(fixture.context);
    await transaction.swapExistingCandidate(fixture.context);
    const fsPromises = Object.create(fs.promises);
    fsPromises.open = async (filePath, ...args) => {
      if (fixture.liveHealthRequests.length > 0 && filePath === path.join(fixture.targetPath, 'server.properties')) {
        throw inspectionError;
      }
      return fs.promises.open(filePath, ...args);
    };
    fixture.context.fsPromises = fsPromises;

    let validationError;
    await assert.rejects(transaction.markCommittedHealthy(fixture.context), error => {
      validationError = error;
      return true;
    });

    assert.equal(stopCalls, 1, 'the exact unadopted health process must receive one cleanup attempt');
    assert.equal(live, !closes);
    if (closes) {
      assert.equal(validationError, inspectionError);
      assert.deepEqual(validationError.runtimeDiagnostic, { stage: 'exact-snapshot-open', reason: 'unknown' });
    }
    else {
      assert.equal(validationError.code, 'HEALTH_CHECK_FAILED');
      assert.equal(isUnprovenHealthProcessError(validationError), true,
        'rollback must receive the unproven-process signal instead of a recoverable inspection error');
    }
    assert.equal(fixture.calls.some(call => call.startsWith('handoff:')), false);
    assert.equal(fixture.calls.some(call => call.startsWith('revision:')), false);
    assert.equal((await fixture.recoveryRegistry.load(fixture.context.jobId)).phase, 'validating-live');
    assert.equal(fs.readFileSync(path.join(fixture.targetPath, 'server.jar'), 'utf8'), 'new-server');
    assert.equal(fs.readFileSync(path.join(fixture.paths.rollbackPath, 'server.jar'), 'utf8'), 'old-server');
    assert.equal(fs.existsSync(fixture.paths.failedPath), false);
  });
}

test('cleanup failure becomes cleanup-pending and retry never rolls back a healthy canonical server', async (t) => {
  const transaction = require('../../electron/services/modpack-lifecycle/server-directory-transaction.cjs');
  const fixture = await existingFixture(t);
  await transaction.buildExistingCandidate(fixture.context);
  await transaction.swapExistingCandidate(fixture.context);
  await transaction.markCommittedHealthy(fixture.context);
  fixture.context.removeOwnedDirectory = async () => { throw new Error('cleanup blocked'); };

  const pending = await transaction.cleanupCommittedTransaction(fixture.context);
  assert.equal(pending.phase, 'cleanup-pending');
  assert.equal(fs.readFileSync(path.join(fixture.targetPath, 'server.jar'), 'utf8'), 'new-server');
  assert.equal(fs.readFileSync(path.join(fixture.paths.rollbackPath, 'server.jar'), 'utf8'), 'old-server');
  assert.equal((await fixture.recoveryRegistry.load(fixture.context.jobId)).phase, 'cleanup-pending');

  delete fixture.context.removeOwnedDirectory;
  const completed = await transaction.cleanupCommittedTransaction(fixture.context);
  assert.equal(completed.phase, 'completed');
  assert.equal(fs.existsSync(fixture.paths.rollbackPath), false);
  assert.equal(fs.readFileSync(path.join(fixture.targetPath, 'server.jar'), 'utf8'), 'new-server');
});

test('cleanup accepts canonical data written by the validated live boot without deleting the healthy server', async (t) => {
  const transaction = require('../../electron/services/modpack-lifecycle/server-directory-transaction.cjs');
  const fixture = await existingFixture(t, { mutateCanonicalDuringLiveHealth: true });
  await transaction.buildExistingCandidate(fixture.context);
  await transaction.swapExistingCandidate(fixture.context);
  await transaction.markCommittedHealthy(fixture.context);

  const cleaned = await transaction.cleanupCommittedTransaction(fixture.context);

  assert.deepEqual(cleaned, { phase: 'completed', rollbackRemoved: true });
  assert.equal(fs.readFileSync(path.join(fixture.targetPath, 'world', 'level.dat'), 'utf8'),
    'world-state-validated-live-boot');
  assert.equal(fs.readFileSync(path.join(fixture.targetPath, 'logs', 'latest.log'), 'utf8'), 'Done (1.000s)!\n');
  assert.equal(fs.existsSync(fixture.paths.rollbackPath), false);
});

test('authorized rollback cleanup uses asynchronous identity-gated directory removal', async (t) => {
  const transaction = require('../../electron/services/modpack-lifecycle/server-directory-transaction.cjs');
  const fixture = await existingFixture(t, { mutateCanonicalDuringLiveHealth: true });
  await transaction.buildExistingCandidate(fixture.context);
  await transaction.swapExistingCandidate(fixture.context);
  await transaction.markCommittedHealthy(fixture.context);
  const fsApi = Object.create(fs);
  for (const method of ['readdirSync', 'rmdirSync', 'unlinkSync']) {
    fsApi[method] = () => { throw new Error(`synchronous cleanup method ${method} must not run`); };
  }
  let asyncRemovalTurns = 0;
  const fsPromises = Object.create(fs.promises);
  fsPromises.unlink = async target => {
    await new Promise(resolve => setImmediate(() => {
      asyncRemovalTurns += 1;
      resolve();
    }));
    return fs.promises.unlink(target);
  };
  fsPromises.rmdir = async target => {
    await new Promise(resolve => setImmediate(() => {
      asyncRemovalTurns += 1;
      resolve();
    }));
    return fs.promises.rmdir(target);
  };
  fixture.context.fsApi = fsApi;
  fixture.context.fsPromises = fsPromises;

  const cleaned = await transaction.cleanupCommittedTransaction(fixture.context);

  assert.deepEqual(cleaned, { phase: 'completed', rollbackRemoved: true });
  assert.ok(asyncRemovalTurns > 0, 'cleanup never yielded through an asynchronous removal');
  assert.equal(fs.existsSync(fixture.paths.rollbackPath), false);
  assert.equal(fs.existsSync(fixture.targetPath), true);
});

test('validating-live recovery trusts lineage after an authorized boot mutates canonical data', async (t) => {
  const transaction = require('../../electron/services/modpack-lifecycle/server-directory-transaction.cjs');
  const healthFailure = Object.assign(new Error('live boot failed after writing world data'), {
    code: 'HEALTH_CHECK_FAILED'
  });
  const fixture = await existingFixture(t, {
    liveHealthError: healthFailure,
    mutateCanonicalDuringLiveHealth: true
  });
  await transaction.buildExistingCandidate(fixture.context);
  await transaction.swapExistingCandidate(fixture.context);

  await assert.rejects(transaction.markCommittedHealthy(fixture.context), error => error === healthFailure);
  assert.equal((await fixture.recoveryRegistry.load(fixture.context.jobId)).phase, 'validating-live');
  assert.match(
    fs.readFileSync(path.join(fixture.targetPath, 'world', 'level.dat'), 'utf8'),
    /validated-live-boot$/
  );
  assert.deepEqual(await transaction.verifyCommittedCanonicalDirectory(fixture.context), {
    phase: 'validating-live', verified: true
  });

  fixture.context.healthValidator.validateLive = async () => ({ evidence: { kind: 'live-retry' }, handoff: null });
  const healthy = await transaction.markCommittedHealthy(fixture.context);
  const cleaned = await transaction.cleanupCommittedTransaction(fixture.context);

  assert.equal(healthy.phase, 'committed-healthy');
  assert.equal(cleaned.phase, 'completed');
  assert.equal(fs.existsSync(fixture.paths.rollbackPath), false);
});

test('validating-live registry-ahead split revalidates the untouched tree before authorizing boot', async (t) => {
  const transaction = require('../../electron/services/modpack-lifecycle/server-directory-transaction.cjs');
  const fixture = await existingFixture(t);
  await transaction.buildExistingCandidate(fixture.context);
  await transaction.swapExistingCandidate(fixture.context);

  const journalPath = path.join(
    fixture.targetPath, '.minecraft-core-state', 'operations', fixture.context.jobId, 'journal.json'
  );
  const base = fixture.context.durableFs;
  let blocked = true;
  const wrapped = {
    ...base,
    async writeJsonAtomicAsync(filePath, value, options) {
      if (blocked && path.resolve(filePath) === path.resolve(journalPath) && value.phase === 'validating-live') {
        blocked = false;
        throw Object.assign(new Error('journal validating-live write blocked'), { code: 'COMMIT_FAILED' });
      }
      return base.writeJsonAtomicAsync(filePath, value, options);
    }
  };
  fixture.context.durableFs = wrapped;
  fixture.recoveryRegistry.durableFs = wrapped;

  await assert.rejects(transaction.markCommittedHealthy(fixture.context));
  const splitRecord = await fixture.recoveryRegistry.load(fixture.context.jobId);
  assert.equal(splitRecord.phase, 'validating-live');
  assert.match(splitRecord.outcome.liveValidation.properties.sha256, /^[a-f0-9]{64}$/);
  assert.equal(JSON.parse(fs.readFileSync(journalPath, 'utf8')).phase, 'starting');
  const rollbackEvidence = await transaction.verifyMutableOperationOwnedDirectory(
    fixture.context,
    fixture.targetPath,
    splitRecord.directoryIdentities.target
  );
  assert.equal(rollbackEvidence.journalRecord.phase, 'starting');
  assert.equal(rollbackEvidence.inspection.fingerprint, splitRecord.outcome.candidate.fingerprint);

  fixture.context.durableFs = base;
  fixture.recoveryRegistry.durableFs = base;
  assert.deepEqual(await transaction.verifyCommittedCanonicalDirectory(fixture.context), {
    phase: 'validating-live', verified: true
  });
  const healthy = await transaction.markCommittedHealthy(fixture.context);
  assert.equal(healthy.phase, 'committed-healthy');
  assert.equal(JSON.parse(fs.readFileSync(journalPath, 'utf8')).phase, 'committed-healthy');
});

test('starting registry-ahead publication split reconciles the pre-boot journal before health', async (t) => {
  const transaction = require('../../electron/services/modpack-lifecycle/server-directory-transaction.cjs');
  const fixture = await existingFixture(t);
  await transaction.buildExistingCandidate(fixture.context);

  const targetJournalPath = path.join(
    fixture.targetPath, '.minecraft-core-state', 'operations', fixture.context.jobId, 'journal.json'
  );
  const base = fixture.context.durableFs;
  let blocked = true;
  const wrapped = {
    ...base,
    async writeJsonAtomicAsync(filePath, value, options) {
      if (blocked && path.resolve(filePath) === path.resolve(targetJournalPath) && value.phase === 'starting') {
        blocked = false;
        throw Object.assign(new Error('journal publication write blocked'), { code: 'COMMIT_FAILED' });
      }
      return base.writeJsonAtomicAsync(filePath, value, options);
    }
  };
  fixture.context.durableFs = wrapped;
  fixture.recoveryRegistry.durableFs = wrapped;

  await assert.rejects(transaction.swapExistingCandidate(fixture.context));
  const splitRecord = await fixture.recoveryRegistry.load(fixture.context.jobId);
  assert.equal(splitRecord.phase, 'starting');
  assert.equal(splitRecord.swapStep, 'candidate-published');
  assert.equal(JSON.parse(fs.readFileSync(targetJournalPath, 'utf8')).phase, 'committing');
  assert.equal(fixture.calls.includes('health:live'), false);

  fixture.context.durableFs = base;
  fixture.recoveryRegistry.durableFs = base;
  const healthy = await transaction.markCommittedHealthy(fixture.context);

  assert.equal(healthy.phase, 'committed-healthy');
  assert.equal(fixture.calls.filter(call => call === 'health:live').length, 1);
  assert.equal(JSON.parse(fs.readFileSync(targetJournalPath, 'utf8')).phase, 'committed-healthy');
});

test('validating-live retry enforces the durable pre-boot server properties snapshot', async (t) => {
  const transaction = require('../../electron/services/modpack-lifecycle/server-directory-transaction.cjs');
  const healthFailure = Object.assign(new Error('live boot failed after changing properties'), {
    code: 'HEALTH_CHECK_FAILED'
  });
  const fixture = await existingFixture(t, {
    liveHealthError: healthFailure,
    mutatePropertiesDuringLiveHealth: true
  });
  await transaction.buildExistingCandidate(fixture.context);
  await transaction.swapExistingCandidate(fixture.context);

  await assert.rejects(transaction.markCommittedHealthy(fixture.context), error => error === healthFailure);
  const record = await fixture.recoveryRegistry.load(fixture.context.jobId);
  assert.equal(record.phase, 'validating-live');
  assert.match(record.outcome.liveValidation.properties.sha256, /^[a-f0-9]{64}$/);

  let retriedHealth = false;
  fixture.context.healthValidator.validateLive = async () => {
    retriedHealth = true;
    return { evidence: { kind: 'should-not-run' }, handoff: null };
  };
  await assert.rejects(
    transaction.markCommittedHealthy(fixture.context),
    error => error?.code === 'HEALTH_CHECK_FAILED'
  );
  assert.equal(retriedHealth, false);
  assert.equal(fs.existsSync(fixture.paths.rollbackPath), true);
});

test('mutable rollback verifier accepts journal-ahead rename and restore crash splits', async (t) => {
  const { OperationJournal } = require('../../electron/services/modpack-lifecycle/operation-journal.cjs');
  const transaction = require('../../electron/services/modpack-lifecycle/server-directory-transaction.cjs');
  const healthFailure = Object.assign(new Error('live boot failed'), { code: 'HEALTH_CHECK_FAILED' });
  const fixture = await existingFixture(t, { liveHealthError: healthFailure });
  await transaction.buildExistingCandidate(fixture.context);
  await transaction.swapExistingCandidate(fixture.context);
  await assert.rejects(transaction.markCommittedHealthy(fixture.context), error => error === healthFailure);

  let record = await fixture.recoveryRegistry.load(fixture.context.jobId);
  record = await fixture.recoveryRegistry.transition(fixture.context.jobId, {
    expectedPhase: 'validating-live',
    nextPhase: 'rolling-back',
    patch: {
      outcome: { ...record.outcome, liveMutationAuthorized: true }
    }
  });
  const journalPath = path.join(
    fixture.targetPath, '.minecraft-core-state', 'operations', fixture.context.jobId, 'journal.json'
  );
  const journal = new OperationJournal({
    durableFs: fixture.context.durableFs,
    fsApi: fs,
    clock: fixture.context.clock
  });
  await journal.transition(journalPath, {
    expectedPhase: 'validating-live',
    nextPhase: 'rolling-back',
    patch: { swapStep: 'candidate-published' }
  });
  fixture.context.durableFs.renameDurable(fixture.targetPath, fixture.paths.failedPath);
  const failedJournalPath = path.join(
    fixture.paths.failedPath, '.minecraft-core-state', 'operations', fixture.context.jobId, 'journal.json'
  );
  await journal.transition(failedJournalPath, {
    expectedPhase: 'rolling-back',
    nextPhase: 'rolling-back',
    patch: {
      swapStep: 'failed-canonical-moved',
      targetIdentity: null,
      failedIdentity: record.directoryIdentities.target
    }
  });

  const renamed = await transaction.verifyMutableOperationOwnedDirectory(
    fixture.context,
    fixture.paths.failedPath,
    record.directoryIdentities.target
  );
  assert.equal(renamed.journalRecord.swapStep, 'failed-canonical-moved');

  record = await fixture.recoveryRegistry.transition(fixture.context.jobId, {
    expectedPhase: 'rolling-back',
    nextPhase: 'rolling-back',
    patch: {
      swapStep: 'failed-canonical-moved',
      directoryIdentities: {
        ...record.directoryIdentities,
        target: null,
        failed: record.directoryIdentities.target
      }
    }
  });
  fixture.context.durableFs.renameDurable(fixture.paths.rollbackPath, fixture.targetPath);
  await journal.transition(failedJournalPath, {
    expectedPhase: 'rolling-back',
    nextPhase: 'rolled-back',
    patch: {
      swapStep: 'rollback-restored',
      targetIdentity: record.directoryIdentities.rollback,
      rollbackIdentity: record.directoryIdentities.rollback,
      failedIdentity: record.directoryIdentities.failed
    }
  });

  const restored = await transaction.verifyMutableOperationOwnedDirectory(
    fixture.context,
    fixture.paths.failedPath,
    record.directoryIdentities.failed
  );
  assert.equal(restored.journalRecord.swapStep, 'rollback-restored');
});

test('committed cleanup retains rollback when immutable ownership or rollback evidence is tampered', async (t) => {
  await t.test('target directory identity replacement', async (subtest) => {
    const transaction = require('../../electron/services/modpack-lifecycle/server-directory-transaction.cjs');
    const fixture = await existingFixture(subtest, { mutateCanonicalDuringLiveHealth: true });
    await transaction.buildExistingCandidate(fixture.context);
    await transaction.swapExistingCandidate(fixture.context);
    await transaction.markCommittedHealthy(fixture.context);
    fs.renameSync(fixture.targetPath, `${fixture.targetPath}-healthy-original`);
    fs.mkdirSync(fixture.targetPath);

    await assert.rejects(
      transaction.cleanupCommittedTransaction(fixture.context),
      error => error?.code === 'RECOVERY_REQUIRED'
    );
    assert.equal(fs.existsSync(fixture.paths.rollbackPath), true);
    assert.equal(fs.existsSync(`${fixture.targetPath}-healthy-original`), true);
  });

  await t.test('operation marker tamper', async (subtest) => {
    const transaction = require('../../electron/services/modpack-lifecycle/server-directory-transaction.cjs');
    const fixture = await existingFixture(subtest, { mutateCanonicalDuringLiveHealth: true });
    await transaction.buildExistingCandidate(fixture.context);
    await transaction.swapExistingCandidate(fixture.context);
    await transaction.markCommittedHealthy(fixture.context);
    const markerPath = path.join(
      fixture.targetPath, '.minecraft-core-state', 'operations', fixture.context.jobId, 'directory-marker.json'
    );
    const marker = JSON.parse(fs.readFileSync(markerPath, 'utf8'));
    fs.writeFileSync(markerPath, `${JSON.stringify({ ...marker, stableInstanceId: 'server-unrelated' })}\n`);

    await assert.rejects(
      transaction.cleanupCommittedTransaction(fixture.context),
      error => error?.code === 'RECOVERY_REQUIRED'
    );
    assert.equal(fs.existsSync(fixture.paths.rollbackPath), true);
  });

  await t.test('checksummed journal revision mismatch', async (subtest) => {
    const { OperationJournal } = require('../../electron/services/modpack-lifecycle/operation-journal.cjs');
    const transaction = require('../../electron/services/modpack-lifecycle/server-directory-transaction.cjs');
    const fixture = await existingFixture(subtest, { mutateCanonicalDuringLiveHealth: true });
    await transaction.buildExistingCandidate(fixture.context);
    await transaction.swapExistingCandidate(fixture.context);
    await transaction.markCommittedHealthy(fixture.context);
    const journalPath = path.join(
      fixture.targetPath, '.minecraft-core-state', 'operations', fixture.context.jobId, 'journal.json'
    );
    await new OperationJournal({
      durableFs: fixture.context.durableFs,
      fsApi: fixture.context.fsApi,
      clock: fixture.context.clock
    }).transition(journalPath, {
      expectedPhase: 'committed-healthy',
      nextPhase: 'committed-healthy',
      patch: { revisionEventId: 'modpack-content-revision:unrelated:999' }
    });

    await assert.rejects(
      transaction.cleanupCommittedTransaction(fixture.context),
      error => error?.code === 'RECOVERY_REQUIRED'
    );
    assert.equal(fs.existsSync(fixture.paths.rollbackPath), true);
  });

  await t.test('registry marker provenance mismatch', async (subtest) => {
    const transaction = require('../../electron/services/modpack-lifecycle/server-directory-transaction.cjs');
    const fixture = await existingFixture(subtest, { mutateCanonicalDuringLiveHealth: true });
    await transaction.buildExistingCandidate(fixture.context);
    await transaction.swapExistingCandidate(fixture.context);
    await transaction.markCommittedHealthy(fixture.context);
    const record = await fixture.recoveryRegistry.load(fixture.context.jobId);
    await fixture.recoveryRegistry.transition(fixture.context.jobId, {
      expectedPhase: 'committed-healthy',
      nextPhase: 'committed-healthy',
      patch: {
        outcome: {
          ...record.outcome,
          candidate: { ...record.outcome.candidate, markerSha256: 'f'.repeat(64) }
        }
      }
    });

    await assert.rejects(
      transaction.cleanupCommittedTransaction(fixture.context),
      error => error?.code === 'RECOVERY_REQUIRED'
    );
    assert.equal(fs.existsSync(fixture.paths.rollbackPath), true);
  });

  await t.test('rollback content mutation', async (subtest) => {
    const transaction = require('../../electron/services/modpack-lifecycle/server-directory-transaction.cjs');
    const fixture = await existingFixture(subtest, { mutateCanonicalDuringLiveHealth: true });
    await transaction.buildExistingCandidate(fixture.context);
    await transaction.swapExistingCandidate(fixture.context);
    await transaction.markCommittedHealthy(fixture.context);
    fs.writeFileSync(path.join(fixture.paths.rollbackPath, 'server.jar'), 'tampered rollback');

    const pending = await transaction.cleanupCommittedTransaction(fixture.context);

    assert.equal(pending.phase, 'cleanup-pending');
    assert.equal(pending.rollbackRemoved, false);
    assert.equal(fs.existsSync(fixture.paths.rollbackPath), true);
    assert.equal(fs.readFileSync(path.join(fixture.paths.rollbackPath, 'server.jar'), 'utf8'), 'tampered rollback');
    assert.equal(fs.readFileSync(path.join(fixture.targetPath, 'server.jar'), 'utf8'), 'new-server');
  });

  await t.test('target replacement immediately before rollback deletion', async (subtest) => {
    const transaction = require('../../electron/services/modpack-lifecycle/server-directory-transaction.cjs');
    const fixture = await existingFixture(subtest, { mutateCanonicalDuringLiveHealth: true });
    await transaction.buildExistingCandidate(fixture.context);
    await transaction.swapExistingCandidate(fixture.context);
    await transaction.markCommittedHealthy(fixture.context);
    const originalBoundary = fixture.context.afterBoundary;
    fixture.context.afterBoundary = async name => {
      await originalBoundary(name);
      if (name !== 'cleanup-started') return;
      fs.renameSync(fixture.targetPath, `${fixture.targetPath}-replaced-after-evidence`);
      fs.mkdirSync(fixture.targetPath);
    };

    const pending = await transaction.cleanupCommittedTransaction(fixture.context);

    assert.equal(pending.phase, 'cleanup-pending');
    assert.equal(pending.rollbackRemoved, false);
    assert.equal(fs.existsSync(fixture.paths.rollbackPath), true);
    assert.equal(fs.existsSync(`${fixture.targetPath}-replaced-after-evidence`), true);
  });
});

test('committed cleanup tolerates canonical writes that race with rollback deletion', async (t) => {
  const transaction = require('../../electron/services/modpack-lifecycle/server-directory-transaction.cjs');
  const fixture = await existingFixture(t, {
    mutateCanonicalDuringLiveHealth: true,
    priorRunning: true
  });
  await transaction.buildExistingCandidate(fixture.context);
  await transaction.swapExistingCandidate(fixture.context);
  await transaction.markCommittedHealthy(fixture.context);
  fixture.context.removeOwnedDirectory = async ({ directoryPath }) => {
    fs.appendFileSync(path.join(fixture.targetPath, 'world', 'level.dat'), '-running-write-during-cleanup');
    fs.rmSync(directoryPath, { recursive: true });
  };

  const cleaned = await transaction.cleanupCommittedTransaction(fixture.context);

  assert.equal(cleaned.phase, 'completed');
  assert.match(
    fs.readFileSync(path.join(fixture.targetPath, 'world', 'level.dat'), 'utf8'),
    /running-write-during-cleanup$/
  );
  assert.equal(fs.existsSync(fixture.paths.rollbackPath), false);
});

test('cleanup batches sibling directory durability so native helper launches scale with depth', async (t) => {
  const transaction = require('../../electron/services/modpack-lifecycle/server-directory-transaction.cjs');
  const nativeFlushPaths = [];
  const nativeAsyncFlushPaths = [];
  const nativeAsyncFlushBatches = [];
  const durableClient = {
    moveWriteThrough(source, destination) { fs.renameSync(source, destination); },
    async moveWriteThroughAsync(source, destination) {
      await new Promise(resolve => setImmediate(resolve));
      fs.renameSync(source, destination);
    },
    replaceFileWriteThrough(source, destination) { fs.renameSync(source, destination); },
    async replaceFileWriteThroughAsync(source, destination) {
      await new Promise(resolve => setImmediate(resolve));
      fs.renameSync(source, destination);
    },
    flushDirectory(directoryPath) { nativeFlushPaths.push(path.resolve(directoryPath)); },
    async flushDirectoryAsync(directoryPath) {
      nativeAsyncFlushPaths.push(path.resolve(directoryPath));
      await new Promise(resolve => setImmediate(resolve));
    },
    async flushDirectoriesAsync(directoryPaths) {
      nativeAsyncFlushBatches.push(directoryPaths.map(candidate => path.resolve(candidate)));
      await new Promise(resolve => setImmediate(resolve));
    }
  };
  const fixture = await existingFixture(t, {
    durableClient,
    mutateCanonicalDuringLiveHealth: true
  });
  const siblingNames = [];
  for (let index = 0; index < 24; index += 1) {
    const name = `sibling-${String(index).padStart(2, '0')}`;
    siblingNames.push(name);
    fs.mkdirSync(path.join(fixture.targetPath, name));
    fs.writeFileSync(path.join(fixture.targetPath, name, 'entry.dat'), `entry-${index}`);
  }
  await transaction.buildExistingCandidate(fixture.context);
  await transaction.swapExistingCandidate(fixture.context);
  await transaction.markCommittedHealthy(fixture.context);
  nativeFlushPaths.length = 0;
  nativeAsyncFlushPaths.length = 0;
  nativeAsyncFlushBatches.length = 0;

  const cleaned = await transaction.cleanupCommittedTransaction(fixture.context);

  assert.equal(cleaned.phase, 'completed');
  assert.equal(cleaned.rollbackRemoved, true);
  const rollbackSiblings = siblingNames.map(name => path.join(fixture.paths.rollbackPath, name));
  const siblingKeys = new Set(rollbackSiblings.map(candidate => path.resolve(candidate)));
  const siblingBatches = nativeAsyncFlushBatches.filter(batch => batch.some(candidate => siblingKeys.has(candidate)));
  assert.equal(siblingBatches.length, 1);
  assert.deepEqual(
    siblingBatches[0].filter(candidate => siblingKeys.has(candidate)).sort(),
    [...siblingKeys].sort()
  );
  assert.deepEqual(nativeAsyncFlushPaths.filter(candidate => siblingKeys.has(candidate)), []);
  assert.deepEqual(nativeFlushPaths.filter(candidate => siblingKeys.has(candidate)), []);
});

test('cleanup retains empty rollback directories until their durability batch succeeds and then resumes', async (t) => {
  const transaction = require('../../electron/services/modpack-lifecycle/server-directory-transaction.cjs');
  let failBatch = false;
  const durableClient = {
    moveWriteThrough(source, destination) { fs.renameSync(source, destination); },
    async moveWriteThroughAsync(source, destination) {
      await new Promise(resolve => setImmediate(resolve));
      fs.renameSync(source, destination);
    },
    replaceFileWriteThrough(source, destination) { fs.renameSync(source, destination); },
    async replaceFileWriteThroughAsync(source, destination) {
      await new Promise(resolve => setImmediate(resolve));
      fs.renameSync(source, destination);
    },
    flushDirectory() {},
    async flushDirectoryAsync() { await new Promise(resolve => setImmediate(resolve)); },
    async flushDirectoriesAsync() {
      await new Promise(resolve => setImmediate(resolve));
      if (failBatch) throw Object.assign(new Error('injected cleanup durability failure'), { code: 'COMMIT_FAILED' });
    }
  };
  const fixture = await existingFixture(t, {
    durableClient,
    mutateCanonicalDuringLiveHealth: true
  });
  const protectedDirectory = path.join(fixture.targetPath, 'durability-boundary');
  fs.mkdirSync(protectedDirectory);
  fs.writeFileSync(path.join(protectedDirectory, 'entry.dat'), 'rollback-only');
  await transaction.buildExistingCandidate(fixture.context);
  await transaction.swapExistingCandidate(fixture.context);
  await transaction.markCommittedHealthy(fixture.context);
  failBatch = true;

  const pending = await transaction.cleanupCommittedTransaction(fixture.context);

  const rollbackDirectory = path.join(fixture.paths.rollbackPath, 'durability-boundary');
  assert.equal(pending.phase, 'cleanup-pending');
  assert.equal(pending.rollbackRemoved, false);
  assert.equal(fs.existsSync(rollbackDirectory), true);
  assert.equal(
    (await fixture.recoveryRegistry.load(fixture.context.jobId)).outcome.cleanup.deletionAuthorized,
    true
  );

  failBatch = false;
  const resumed = await transaction.cleanupCommittedTransaction(fixture.context);
  assert.deepEqual(resumed, { phase: 'completed', rollbackRemoved: true });
  assert.equal(fs.existsSync(fixture.paths.rollbackPath), false);
});

test('cleanup retries the rollback parent flush after the rollback root was removed', async (t) => {
  const transaction = require('../../electron/services/modpack-lifecycle/server-directory-transaction.cjs');
  let rollbackParentPath = null;
  let failRollbackParentFlush = false;
  let rollbackParentFlushAttempts = 0;
  const durableClient = {
    moveWriteThrough(source, destination) { fs.renameSync(source, destination); },
    async moveWriteThroughAsync(source, destination) {
      await new Promise(resolve => setImmediate(resolve));
      fs.renameSync(source, destination);
    },
    replaceFileWriteThrough(source, destination) { fs.renameSync(source, destination); },
    async replaceFileWriteThroughAsync(source, destination) {
      await new Promise(resolve => setImmediate(resolve));
      fs.renameSync(source, destination);
    },
    flushDirectory() {},
    async flushDirectoryAsync(directoryPath) {
      await new Promise(resolve => setImmediate(resolve));
      if (!failRollbackParentFlush || path.resolve(directoryPath) !== rollbackParentPath) return;
      rollbackParentFlushAttempts += 1;
      if (rollbackParentFlushAttempts === 1) {
        throw Object.assign(new Error('injected post-root-removal parent flush failure'), {
          code: 'COMMIT_FAILED'
        });
      }
    }
  };
  const fixture = await existingFixture(t, {
    durableClient,
    mutateCanonicalDuringLiveHealth: true
  });
  await transaction.buildExistingCandidate(fixture.context);
  await transaction.swapExistingCandidate(fixture.context);
  await transaction.markCommittedHealthy(fixture.context);
  rollbackParentPath = path.resolve(path.dirname(fixture.paths.rollbackPath));
  failRollbackParentFlush = true;

  const pending = await transaction.cleanupCommittedTransaction(fixture.context);

  assert.equal(pending.phase, 'cleanup-pending');
  assert.equal(pending.rollbackRemoved, false);
  assert.equal(fs.existsSync(fixture.paths.rollbackPath), false);
  assert.equal(rollbackParentFlushAttempts, 1);
  assert.equal(
    (await fixture.recoveryRegistry.load(fixture.context.jobId)).outcome.cleanup.deletionAuthorized,
    true
  );

  const resumed = await transaction.cleanupCommittedTransaction(fixture.context);

  assert.deepEqual(resumed, { phase: 'completed', rollbackRemoved: true });
  assert.equal(rollbackParentFlushAttempts, 2);
  assert.equal(fs.existsSync(fixture.paths.rollbackPath), false);
});

test('authorized cleanup rejects a reparse entry before deleting it', async (t) => {
  const transaction = require('../../electron/services/modpack-lifecycle/server-directory-transaction.cjs');
  const fixture = await existingFixture(t, { mutateCanonicalDuringLiveHealth: true });
  await transaction.buildExistingCandidate(fixture.context);
  await transaction.swapExistingCandidate(fixture.context);
  await transaction.markCommittedHealthy(fixture.context);
  fixture.context.removeOwnedDirectory = async () => { throw new Error('interrupt after deletion authorization'); };
  const interrupted = await transaction.cleanupCommittedTransaction(fixture.context);
  assert.equal(interrupted.phase, 'cleanup-pending');
  assert.equal(
    (await fixture.recoveryRegistry.load(fixture.context.jobId)).outcome.cleanup.deletionAuthorized,
    true
  );
  delete fixture.context.removeOwnedDirectory;
  const protectedEntry = path.join(fixture.paths.rollbackPath, 'server.properties');
  const inspected = [];
  fixture.context.reparseInspector = {
    async isReparsePoint(candidate) {
      const resolved = path.resolve(candidate);
      inspected.push(resolved);
      return resolved === protectedEntry;
    }
  };

  const pending = await transaction.cleanupCommittedTransaction(fixture.context);

  assert.equal(pending.phase, 'cleanup-pending');
  assert.equal(pending.rollbackRemoved, false);
  assert.equal(fs.existsSync(protectedEntry), true);
  assert.equal(inspected.includes(protectedEntry), true);
});

test('cleanup reconciles split durable phases and resumes after rollback deletion', async (t) => {
  await t.test('registry cleanup with journal still committed-healthy', async (subtest) => {
    const { OperationJournal } = require('../../electron/services/modpack-lifecycle/operation-journal.cjs');
    const transaction = require('../../electron/services/modpack-lifecycle/server-directory-transaction.cjs');
    const fixture = await existingFixture(subtest, { mutateCanonicalDuringLiveHealth: true });
    await transaction.buildExistingCandidate(fixture.context);
    await transaction.swapExistingCandidate(fixture.context);
    await transaction.markCommittedHealthy(fixture.context);
    await fixture.recoveryRegistry.transition(fixture.context.jobId, {
      expectedPhase: 'committed-healthy', nextPhase: 'cleanup', patch: {}
    });

    const cleaned = await transaction.cleanupCommittedTransaction(fixture.context);
    const journalPath = path.join(
      fixture.targetPath, '.minecraft-core-state', 'operations', fixture.context.jobId, 'journal.json'
    );
    const journal = new OperationJournal({
      durableFs: fixture.context.durableFs,
      fsApi: fixture.context.fsApi,
      clock: fixture.context.clock
    }).load(journalPath);

    assert.equal(cleaned.phase, 'completed');
    assert.equal(journal.phase, 'completed');
    assert.equal(journal.swapStep, 'cleanup-complete');
    assert.equal(fs.existsSync(fixture.paths.rollbackPath), false);
  });

  await t.test('rollback removed before cleanup completion', async (subtest) => {
    const transaction = require('../../electron/services/modpack-lifecycle/server-directory-transaction.cjs');
    const fixture = await existingFixture(subtest, { mutateCanonicalDuringLiveHealth: true });
    await transaction.buildExistingCandidate(fixture.context);
    await transaction.swapExistingCandidate(fixture.context);
    await transaction.markCommittedHealthy(fixture.context);
    fixture.fault.boundary = 'rollback-removed';

    const interrupted = await transaction.cleanupCommittedTransaction(fixture.context);
    assert.equal(interrupted.phase, 'cleanup-pending');
    assert.equal(fs.existsSync(fixture.paths.rollbackPath), false);

    fixture.fault.boundary = null;
    const resumed = await transaction.cleanupCommittedTransaction(fixture.context);
    assert.deepEqual(resumed, { phase: 'completed', rollbackRemoved: true });
    assert.equal(fs.existsSync(fixture.targetPath), true);
  });

  await t.test('registry cleanup with journal cleanup-pending', async (subtest) => {
    const { OperationJournal } = require('../../electron/services/modpack-lifecycle/operation-journal.cjs');
    const transaction = require('../../electron/services/modpack-lifecycle/server-directory-transaction.cjs');
    const fixture = await existingFixture(subtest, { mutateCanonicalDuringLiveHealth: true });
    await transaction.buildExistingCandidate(fixture.context);
    await transaction.swapExistingCandidate(fixture.context);
    await transaction.markCommittedHealthy(fixture.context);
    await fixture.recoveryRegistry.transition(fixture.context.jobId, {
      expectedPhase: 'committed-healthy', nextPhase: 'cleanup', patch: {}
    });
    const journalPath = path.join(
      fixture.targetPath, '.minecraft-core-state', 'operations', fixture.context.jobId, 'journal.json'
    );
    const journal = new OperationJournal({
      durableFs: fixture.context.durableFs,
      fsApi: fixture.context.fsApi,
      clock: fixture.context.clock
    });
    await journal.transition(journalPath, {
      expectedPhase: 'committed-healthy', nextPhase: 'cleanup', patch: {}
    });
    await journal.transition(journalPath, {
      expectedPhase: 'cleanup', nextPhase: 'cleanup-pending', patch: {}
    });

    const cleaned = await transaction.cleanupCommittedTransaction(fixture.context);

    assert.equal(cleaned.phase, 'completed');
    assert.equal(journal.load(journalPath).phase, 'completed');
    assert.equal(fs.existsSync(fixture.paths.rollbackPath), false);
  });

  await t.test('partial rollback deletion resumes without weakening pre-cleanup fingerprint verification', async (subtest) => {
    const transaction = require('../../electron/services/modpack-lifecycle/server-directory-transaction.cjs');
    const fixture = await existingFixture(subtest, { mutateCanonicalDuringLiveHealth: true });
    await transaction.buildExistingCandidate(fixture.context);
    await transaction.swapExistingCandidate(fixture.context);
    await transaction.markCommittedHealthy(fixture.context);
    fixture.context.removeOwnedDirectory = async ({ directoryPath }) => {
      fs.unlinkSync(path.join(directoryPath, 'server.jar'));
      throw new Error('crash during rollback deletion');
    };

    const interrupted = await transaction.cleanupCommittedTransaction(fixture.context);
    assert.equal(interrupted.phase, 'cleanup-pending');
    assert.equal(fs.existsSync(fixture.paths.rollbackPath), true);
    assert.equal(fs.existsSync(path.join(fixture.paths.rollbackPath, 'server.jar')), false);
    assert.equal(
      (await fixture.recoveryRegistry.load(fixture.context.jobId)).outcome.cleanup.deletionAuthorized,
      true
    );

    delete fixture.context.removeOwnedDirectory;
    const resumed = await transaction.cleanupCommittedTransaction(fixture.context);
    assert.equal(resumed.phase, 'completed');
    assert.equal(fs.existsSync(fixture.paths.rollbackPath), false);
  });

  await t.test('registry completed with journal cleanup', async (subtest) => {
    const { OperationJournal } = require('../../electron/services/modpack-lifecycle/operation-journal.cjs');
    const transaction = require('../../electron/services/modpack-lifecycle/server-directory-transaction.cjs');
    const fixture = await existingFixture(subtest, { mutateCanonicalDuringLiveHealth: true });
    await transaction.buildExistingCandidate(fixture.context);
    await transaction.swapExistingCandidate(fixture.context);
    await transaction.markCommittedHealthy(fixture.context);
    await fixture.recoveryRegistry.transition(fixture.context.jobId, {
      expectedPhase: 'committed-healthy', nextPhase: 'cleanup', patch: {}
    });
    const cleanupRecord = await fixture.recoveryRegistry.load(fixture.context.jobId);
    await fixture.recoveryRegistry.transition(fixture.context.jobId, {
      expectedPhase: 'cleanup',
      nextPhase: 'completed',
      patch: {
        swapStep: 'cleanup-complete',
        outcome: { ...cleanupRecord.outcome, cleanup: { rollbackRemoved: true } }
      }
    });
    const journalPath = path.join(
      fixture.targetPath, '.minecraft-core-state', 'operations', fixture.context.jobId, 'journal.json'
    );
    const journal = new OperationJournal({
      durableFs: fixture.context.durableFs,
      fsApi: fixture.context.fsApi,
      clock: fixture.context.clock
    });
    await journal.transition(journalPath, {
      expectedPhase: 'committed-healthy', nextPhase: 'cleanup', patch: {}
    });
    fs.rmSync(fixture.paths.rollbackPath, { recursive: true });

    const reconciled = await transaction.cleanupCommittedTransaction(fixture.context);

    assert.deepEqual(reconciled, { phase: 'completed', rollbackRemoved: true });
    assert.equal(journal.load(journalPath).phase, 'completed');
    assert.equal(journal.load(journalPath).swapStep, 'cleanup-complete');
  });

  await t.test('legacy cleanup-pending without deletion authority rejects a changed rollback', async (subtest) => {
    const { OperationJournal } = require('../../electron/services/modpack-lifecycle/operation-journal.cjs');
    const transaction = require('../../electron/services/modpack-lifecycle/server-directory-transaction.cjs');
    const fixture = await existingFixture(subtest, { mutateCanonicalDuringLiveHealth: true });
    await transaction.buildExistingCandidate(fixture.context);
    await transaction.swapExistingCandidate(fixture.context);
    await transaction.markCommittedHealthy(fixture.context);
    await fixture.recoveryRegistry.transition(fixture.context.jobId, {
      expectedPhase: 'committed-healthy', nextPhase: 'cleanup', patch: {}
    });
    const cleanupRecord = await fixture.recoveryRegistry.load(fixture.context.jobId);
    await fixture.recoveryRegistry.transition(fixture.context.jobId, {
      expectedPhase: 'cleanup',
      nextPhase: 'cleanup-pending',
      patch: {
        outcome: { ...cleanupRecord.outcome, cleanup: { rollbackRemoved: false } }
      }
    });
    const journalPath = path.join(
      fixture.targetPath, '.minecraft-core-state', 'operations', fixture.context.jobId, 'journal.json'
    );
    const journal = new OperationJournal({
      durableFs: fixture.context.durableFs,
      fsApi: fixture.context.fsApi,
      clock: fixture.context.clock
    });
    await journal.transition(journalPath, {
      expectedPhase: 'committed-healthy', nextPhase: 'cleanup', patch: {}
    });
    await journal.transition(journalPath, {
      expectedPhase: 'cleanup', nextPhase: 'cleanup-pending', patch: {}
    });
    fs.writeFileSync(path.join(fixture.paths.rollbackPath, 'server.jar'), 'legacy-tamper');

    const pending = await transaction.cleanupCommittedTransaction(fixture.context);

    assert.equal(pending.phase, 'cleanup-pending');
    assert.equal(pending.rollbackRemoved, false);
    assert.equal(fs.existsSync(fixture.paths.rollbackPath), true);
    assert.equal(fs.readFileSync(path.join(fixture.paths.rollbackPath, 'server.jar'), 'utf8'), 'legacy-tamper');
    assert.equal(
      (await fixture.recoveryRegistry.load(fixture.context.jobId)).outcome.cleanup.deletionAuthorized,
      undefined
    );
  });
});

test('every named swap, health, event, and cleanup boundary retains an unambiguous durable state', async (t) => {
  const transaction = require('../../electron/services/modpack-lifecycle/server-directory-transaction.cjs');
  for (const boundary of ['live-renamed', 'candidate-renamed', 'candidate-published']) {
    await t.test(boundary, async (subtest) => {
      const fixture = await existingFixture(subtest);
      await transaction.buildExistingCandidate(fixture.context);
      fixture.fault.boundary = boundary;
      await assert.rejects(transaction.swapExistingCandidate(fixture.context), new RegExp(`fault after ${boundary}`));
      const record = await fixture.recoveryRegistry.load(fixture.context.jobId);
      if (boundary === 'live-renamed') assert.equal(record.swapStep, 'prepared');
      if (boundary === 'candidate-renamed') assert.equal(record.swapStep, 'live-moved');
      if (boundary === 'candidate-published') assert.equal(record.phase, 'starting');
      assert.equal(Number(fs.existsSync(fixture.targetPath)) + Number(fs.existsSync(fixture.paths.candidatePath)) >= 1, true);
      assert.equal(fs.existsSync(fixture.paths.rollbackPath), true);
    });
  }

  for (const boundary of ['validating-live', 'committed-healthy', 'revision-published']) {
    await t.test(boundary, async (subtest) => {
      const fixture = await existingFixture(subtest);
      await transaction.buildExistingCandidate(fixture.context);
      await transaction.swapExistingCandidate(fixture.context);
      fixture.fault.boundary = boundary;
      await assert.rejects(transaction.markCommittedHealthy(fixture.context), new RegExp(`fault after ${boundary}`));
      const record = await fixture.recoveryRegistry.load(fixture.context.jobId);
      assert.equal(['validating-live', 'committed-healthy'].includes(record.phase), true);
      assert.equal(fs.existsSync(fixture.targetPath), true);
      assert.equal(fs.existsSync(fixture.paths.rollbackPath), true);
    });
  }

  for (const boundary of ['cleanup-started', 'rollback-removed', 'cleanup-complete']) {
    await t.test(boundary, async (subtest) => {
      const fixture = await existingFixture(subtest);
      await transaction.buildExistingCandidate(fixture.context);
      await transaction.swapExistingCandidate(fixture.context);
      await transaction.markCommittedHealthy(fixture.context);
      fixture.fault.boundary = boundary;
      const result = await transaction.cleanupCommittedTransaction(fixture.context);
      const record = await fixture.recoveryRegistry.load(fixture.context.jobId);
      assert.equal(fs.existsSync(fixture.targetPath), true);
      if (boundary === 'cleanup-complete') {
        assert.equal(result.phase, 'completed');
        assert.equal(record.phase, 'completed');
      } else {
        assert.equal(result.phase, 'cleanup-pending');
        assert.equal(record.phase, 'cleanup-pending');
      }
    });
  }
});

function installDurabilityProbe(fixture, { failAt = null, kind }) {
  const baseDurable = fixture.context.durableFs;
  const baseFs = fixture.context.fsApi;
  const baseFsPromises = fixture.context.fsPromises || baseFs.promises || fs.promises;
  let count = 0;
  const fail = () => {
    count += 1;
    if (count === failAt) throw Object.assign(new Error(`injected ${kind} ${count}`), { code: 'COMMIT_FAILED' });
  };
  if (kind === 'write') {
    const wrapped = {
      ...baseDurable,
      async writeJsonAtomicAsync(...args) { fail(); return baseDurable.writeJsonAtomicAsync(...args); }
    };
    fixture.context.durableFs = wrapped;
    fixture.recoveryRegistry.durableFs = wrapped;
  } else if (kind === 'directory-flush') {
    const wrapped = {
      ...baseDurable,
      async flushDirectoryAsync(...args) { fail(); return baseDurable.flushDirectoryAsync(...args); },
      ...(typeof baseDurable.flushDirectoriesAsync === 'function'
        ? { async flushDirectoriesAsync(...args) { fail(); return baseDurable.flushDirectoriesAsync(...args); } }
        : {})
    };
    fixture.context.durableFs = wrapped;
    fixture.recoveryRegistry.durableFs = wrapped;
  } else if (kind === 'file-flush') {
    const wrappedFsPromises = Object.create(baseFsPromises);
    wrappedFsPromises.open = async (...args) => {
      const handle = await baseFsPromises.open(...args);
      return new Proxy(handle, {
        get(target, property) {
          if (property === 'sync') {
            return async () => { fail(); return target.sync(); };
          }
          const value = Reflect.get(target, property, target);
          return typeof value === 'function' ? value.bind(target) : value;
        }
      });
    };
    fixture.context.fsPromises = wrappedFsPromises;
  } else {
    throw new TypeError('unknown durability probe');
  }
  return () => count;
}

test('every candidate record write, directory flush, and file flush fails before the original live path moves', async (t) => {
  const transaction = require('../../electron/services/modpack-lifecycle/server-directory-transaction.cjs');
  for (const kind of ['write', 'directory-flush', 'file-flush']) {
    const baseline = await existingFixture(t);
    const count = installDurabilityProbe(baseline, { kind });
    await transaction.buildExistingCandidate(baseline.context);
    const boundaryCount = count();
    assert.equal(boundaryCount > 0, true);

    for (let failAt = 1; failAt <= boundaryCount; failAt += 1) {
      await t.test(`${kind} ${failAt}/${boundaryCount}`, async (subtest) => {
        const fixture = await existingFixture(subtest);
        installDurabilityProbe(fixture, { failAt, kind });
        await assert.rejects(transaction.buildExistingCandidate(fixture.context));
        assert.equal(fs.existsSync(fixture.targetPath), true);
        assert.equal(fs.existsSync(fixture.paths.rollbackPath), false);
        assert.equal(fs.readFileSync(path.join(fixture.targetPath, 'server.jar'), 'utf8'), 'old-server');
        const record = await fixture.recoveryRegistry.load(fixture.context.jobId);
        assert.equal(record !== null, true);
        assert.equal(['snapshotting', 'staging', 'validating-candidate', 'committing'].includes(record.phase), true);
      });
    }
  }
});

test('every post-build registry or journal write failure leaves a provable canonical choice', async (t) => {
  const transaction = require('../../electron/services/modpack-lifecycle/server-directory-transaction.cjs');
  const baseline = await existingFixture(t);
  await transaction.buildExistingCandidate(baseline.context);
  const count = installDurabilityProbe(baseline, { kind: 'write' });
  await transaction.swapExistingCandidate(baseline.context);
  await transaction.markCommittedHealthy(baseline.context);
  await transaction.cleanupCommittedTransaction(baseline.context);
  const writeCount = count();
  assert.equal(writeCount > 0, true);

  for (let failAt = 1; failAt <= writeCount; failAt += 1) {
    await t.test(`post-build write ${failAt}/${writeCount}`, async (subtest) => {
      const fixture = await existingFixture(subtest);
      await transaction.buildExistingCandidate(fixture.context);
      installDurabilityProbe(fixture, { failAt, kind: 'write' });
      try {
        await transaction.swapExistingCandidate(fixture.context);
        await transaction.markCommittedHealthy(fixture.context);
        await transaction.cleanupCommittedTransaction(fixture.context);
      } catch { /* the durable state below is the assertion */ }
      const record = await fixture.recoveryRegistry.load(fixture.context.jobId);
      assert.equal(record !== null, true);
      const target = fs.existsSync(fixture.targetPath);
      const candidate = fs.existsSync(fixture.paths.candidatePath);
      const rollback = fs.existsSync(fixture.paths.rollbackPath);
      assert.equal(target || candidate || rollback, true);
      assert.equal(target && candidate, false);
      if (!target) {
        assert.equal(candidate, true);
        assert.equal(rollback, true);
        assert.equal(['prepared', 'live-moved'].includes(record.swapStep), true);
      } else {
        const bytes = fs.readFileSync(path.join(fixture.targetPath, 'server.jar'), 'utf8');
        assert.equal(['old-server', 'new-server'].includes(bytes), true);
      }
    });
  }
});
