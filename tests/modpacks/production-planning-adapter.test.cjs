const assert = require('node:assert/strict');
const crypto = require('node:crypto');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const test = require('node:test');

const {
  createArtifactSetPlan,
  finalizeVerifiedArtifactSet
} = require('../../electron/services/modpacks/contracts.cjs');
const {
  ProductionPlanningAdapter,
  sameRepairSource
} = require('../../electron/services/modpacks/planning/production-planning-adapter.cjs');
const {
  createProductionServerSnapshot
} = require('../../electron/services/modpacks/planning/production-server-snapshot.cjs');

const SHA = 'a'.repeat(64);
const SHA512 = 'b'.repeat(128);
const reparseInspector = Object.freeze({ async isReparsePoint() { return false; } });
const availablePortValidation = async () => ({ valid: true, errors: [] });

function verifiedSet() {
  const plan = createArtifactSetPlan({
    provider: 'modrinth',
    project: { id: 'project-one', slug: 'project-one', title: 'Project One' },
    release: { id: 'version-one', version: '1.0.0', channel: 'release', publishedAt: '2026-08-01T00:00:00.000Z' },
    artifactSet: {
      kind: 'single', primaryPartId: 'part-one', groupingScheme: 'single',
      providerImmutable: true, attestationStatus: 'verified',
      parts: [{
        partId: 'part-one', fileName: 'pack.mrpack', size: '1',
        providerDigest: { algorithm: 'sha512', value: SHA512 }
      }]
    }
  });
  return finalizeVerifiedArtifactSet(plan, [{ partId: 'part-one', measuredSize: '1', sha256: SHA, sha512: SHA512 }]);
}

function inspection() {
  return {
    inspectionId: 'inspection-one',
    verifiedArtifactSet: verifiedSet(),
    result: {
      type: 'archive-inspection', archiveFamily: 'mrpack', integrity: 'tested',
      selectedRoot: null,
      artifactSet: { completeness: 'verified-complete-set', fingerprint: SHA },
      classification: {
        kind: 'mrpack-server', confidence: 'exact', blocked: false,
        runtime: {
          minecraftVersion: '1.21.1', loaderFamily: 'fabric', loaderVersion: '0.16.10'
        }
      },
      limitEvidence: { totals: { entryCount: 1, expandedBytes: '1' } }
    }
  };
}

function githubInspection() {
  const plan = createArtifactSetPlan({
    provider: 'github',
    project: { id: '101', slug: 'Owner/Pack', title: 'Owner/Pack' },
    release: { id: '201', version: 'v2.0.0', channel: 'release', publishedAt: '2026-08-01T00:00:00.000Z' },
    artifactSet: {
      kind: 'single', primaryPartId: 'asset-301', groupingScheme: 'single',
      providerImmutable: false, attestationStatus: 'unavailable',
      parts: [{ partId: 'asset-301', providerAssetId: '301', fileName: 'pack-v2.0.0.mrpack', size: '1' }]
    }
  });
  const verified = finalizeVerifiedArtifactSet(plan, [{
    partId: 'asset-301', measuredSize: '1', sha256: SHA, sha512: SHA512
  }]);
  const value = inspection();
  value.verifiedArtifactSet = verified;
  value.result.entries = [{ canonicalName: 'modrinth.index.json', type: 'file', size: '1' }];
  return value;
}

function adapterFor(serverPath, hooks = {}) {
  return new ProductionPlanningAdapter({
    instanceResolver: {
      async resolveInstance(instanceId) { return { instanceId, serverPath, priorRunning: false }; }
    },
    stateRepository: hooks.stateRepository || { read() { return null; } },
    reparseInspector,
    availableBytes: async () => '100000000000',
    validateServerPorts: hooks.validateServerPorts || availablePortValidation,
    preparePlanInputs: async context => {
      hooks.prepared?.(context);
      return hooks.prepareResult || {
        runtime: {
          minecraftVersion: '1.21.1', loaderFamily: 'fabric', loaderVersion: '0.16.10',
          javaMajor: 21, os: 'win32', architecture: 'x64'
        },
        incomingManifest: { schemaVersion: 1, installationId: 'incoming-one', entries: [] },
        candidateBytes: '1', execution: { outputDirectoryId: 'output-one' }
      };
    },
    listAvailableRestorePoints: hooks.listAvailableRestorePoints,
    snapshotServer: async ({ runtime, serverKind }) => ({
      liveSnapshot: { kind: serverKind, worldDirectories: ['world'], protectedPaths: [], entries: [] },
      pathPreconditions: [], sourceRuntime: runtime
    })
  });
}

test('rollback options are a lazy authority-free intersection supplied for the exact saved server', async (t) => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'minecraft-core-rollback-options-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const serverPath = path.join(root, 'server');
  fs.mkdirSync(serverPath);
  const history = [{ operationId: 'operation-one', outcome: 'completed' }];
  const requests = [];
  const runtime = exactRuntime();
  const adapter = adapterFor(serverPath, {
    stateRepository: {
      read(requestedPath) {
        assert.equal(requestedPath, serverPath);
        return { state: { modpackManaged: false, contentRevision: 4 }, manifest: null };
      },
      listHistory(requestedPath, options) {
        assert.equal(requestedPath, serverPath);
        assert.deepEqual(options, { cursor: null, limit: 200 });
        return { items: history };
      }
    },
    async listAvailableRestorePoints(request) {
      requests.push(request);
      return [{
        restorePointId: 'restore-one',
        operationKind: 'upgrade',
        createdAt: '2026-08-01T01:02:03.004Z',
        sourceRevision: 4,
        runtime,
        totalBytes: '1234'
      }];
    }
  });

  assert.deepEqual(await adapter.listRollbackOptions({ instanceId: 'server-one' }), {
    items: [{
      restorePointId: 'restore-one',
      operationKind: 'upgrade',
      createdAt: '2026-08-01T01:02:03.004Z',
      sourceRevision: 4,
      runtime,
      totalBytes: '1234'
    }]
  });
  assert.deepEqual(requests, [{ serverPath, history }]);
});

function exactRuntime({
  minecraftVersion = '1.21.1',
  loaderFamily = 'fabric',
  loaderVersion = '0.16.10'
} = {}) {
  return { minecraftVersion, loaderFamily, loaderVersion, javaMajor: 21, os: 'win32', architecture: 'x64' };
}

function replacementIdentity(provider, targetRuntime, {
  githubRepositoryId = '101',
  githubReleaseId = '201',
  githubOwner = 'Owner',
  githubRepo = 'Pack'
} = {}) {
  const commonArtifact = {
    kind: 'single', primaryPartId: 'runtime-part', groupingScheme: 'single',
    providerImmutable: provider !== 'github', attestationStatus: 'verified',
    parts: [{
      partId: 'runtime-part', fileName: 'runtime-pack.mrpack', size: '1',
      providerDigest: { algorithm: 'sha512', value: SHA512 }
    }]
  };
  const plan = createArtifactSetPlan({
    provider,
    ...(provider === 'local' ? {} : {
      project: provider === 'github'
        ? { id: githubRepositoryId, slug: `${githubOwner}/${githubRepo}`, title: `${githubOwner}/${githubRepo}` }
        : { id: 'project-one', slug: 'project-one', title: 'Project One' },
      release: provider === 'github'
        ? { id: githubReleaseId, version: 'v2.0.0', channel: 'release', publishedAt: '2026-08-01T00:00:00.000Z' }
        : { id: 'version-two', version: '2.0.0', channel: 'release', publishedAt: '2026-08-01T00:00:00.000Z' }
    }),
    artifactSet: commonArtifact
  });
  const verifiedArtifactSet = finalizeVerifiedArtifactSet(plan, [{
    partId: 'runtime-part', measuredSize: '1', sha256: SHA, sha512: SHA512
  }]);
  const source = provider === 'github'
    ? {
        provider, repositoryId: githubRepositoryId, releaseId: githubReleaseId, githubOwner, githubRepo,
        version: 'v2.0.0', title: `${githubOwner}/${githubRepo}`
      }
    : provider === 'modrinth'
      ? { provider, projectId: 'project-one', versionId: 'version-two', version: '2.0.0', title: 'Project One' }
      : {
          provider, importId: 'local-import-two', artifactSha256: verifiedArtifactSet.artifactSet.setDigest,
          version: 'local-import-two', title: 'Local pack'
        };
  return {
    source,
    inspection: {
      inspectionId: 'inspection-one',
      verifiedArtifactSet,
      result: {
        type: 'archive-inspection', archiveFamily: 'mrpack', integrity: 'tested', selectedRoot: null,
        artifactSet: { completeness: 'verified-complete-set', fingerprint: SHA },
        classification: {
          kind: 'mrpack-server', confidence: 'exact', blocked: false,
          runtime: {
            minecraftVersion: targetRuntime.minecraftVersion,
            loaderFamily: targetRuntime.loaderFamily,
            loaderVersion: targetRuntime.loaderVersion
          }
        },
        limitEvidence: { totals: { entryCount: 1, expandedBytes: '1' } }
      }
    }
  };
}

function managedReplacementFixture(t, {
  coordinatorRevision = 7,
  provider = 'modrinth',
  currentRuntime = exactRuntime(),
  targetRuntime = exactRuntime(),
  restorePoints = [],
  duringPrepare = null,
  candidateProgress = null,
  githubIdentity = {},
  currentSource = null
} = {}) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'minecraft-core-runtime-direction-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const serverPath = path.join(root, 'Managed Server');
  fs.mkdirSync(serverPath);
  const identity = replacementIdentity(provider, targetRuntime, githubIdentity);
  const currentState = {
    state: {
      modpackManaged: true, contentRevision: 7, runtime: currentRuntime,
      selectedOptionalFiles: [],
      source: currentSource ?? identity.source
    },
    manifest: { schemaVersion: 1, installationId: 'installed-one', entries: [] }
  };
  const adapter = new ProductionPlanningAdapter({
    instanceResolver: { async resolveInstance(instanceId) { return { instanceId, serverPath, priorRunning: false }; } },
    stateRepository: { read() { return currentState; } },
    readContentRevision: () => typeof coordinatorRevision === 'function' ? coordinatorRevision() : coordinatorRevision,
    reparseInspector,
    availableBytes: async () => '100000000000',
    validateServerPorts: availablePortValidation,
    preparePlanInputs: async context => {
      if (duringPrepare) await duringPrepare(context);
      if (candidateProgress) context.onProgress(candidateProgress);
      return {
        runtime: targetRuntime,
        incomingManifest: { schemaVersion: 1, installationId: 'incoming-two', entries: [] },
        candidateBytes: '1', execution: { outputDirectoryId: 'output-two' }
      };
    },
    snapshotServer: async () => ({
      liveSnapshot: { kind: 'existing', worldDirectories: ['world'], protectedPaths: [], entries: [] },
      pathPreconditions: [], sourceRuntime: currentRuntime, restorePoints,
      candidateBytes: '0', restorePointBytes: '0', rollbackBytes: '0', journalBytes: '1', writeable: true
    })
  });
  function request(operationKind, selections = {}) {
    return {
      inspectionId: 'inspection-one', instanceId: 'server-one', operationKind,
      selections: {
        optionalFileIds: [], conflictChoices: { paths: {}, categories: {} },
        acknowledgeMissingProviderDigest: false, acknowledgeDowngradeWorldRisk: false,
        selectedRoot: null, runtimeChoice: null,
        ...selections
      }
    };
  }
  return { adapter, ...identity, currentRuntime, targetRuntime, request };
}

function installedGithubSource() {
  return {
    provider: 'github', repositoryId: '101', releaseId: '200', githubOwner: 'Owner', githubRepo: 'Pack',
    version: 'v1.0.0', title: 'Owner/Pack', selectedAssetIds: ['300'], artifactSetDigest: '9'.repeat(64),
    assetPattern: {
      type: 'github-asset-pattern', version: 1,
      filenameMatchers: [{ kind: 'single-wildcard', prefix: 'pack-v', suffix: '.mrpack' }],
      reviewedRole: 'mrpack', archiveRootFingerprint: '8'.repeat(64),
      runtimeEvidence: exactRuntime(),
      multipartStructure: { kind: 'single', groupingScheme: 'single', partCount: 1, primaryIndex: 0 },
      userOverrides: { selectedRoot: null, runtimeChoice: null }
    },
    acceptedMapping: {
      type: 'provider-source-mapping', version: 1, modrinthProjectId: 'project-one',
      githubRepositoryId: '101', githubOwner: 'Owner', githubRepo: 'Pack'
    }
  };
}

for (const operationKind of ['update', 'downgrade']) {
  test(`same-repository GitHub ${operationKind} retains the installed asset pattern and accepted mapping`, async t => {
    const currentSource = installedGithubSource();
    const fixture = managedReplacementFixture(t, { provider: 'github', currentSource });

    const reviewed = await fixture.adapter.createPlan({
      request: fixture.request(operationKind, {
        acknowledgeDowngradeWorldRisk: operationKind === 'downgrade'
      }),
      inspection: fixture.inspection,
      source: fixture.source
    });

    const executionSource = fixture.adapter.getExecutionRecord(reviewed.plan).source;
    assert.deepEqual(executionSource.assetPattern, currentSource.assetPattern);
    assert.deepEqual(executionSource.acceptedMapping, currentSource.acceptedMapping);
    assert.notStrictEqual(executionSource.assetPattern, currentSource.assetPattern);
    assert.notStrictEqual(executionSource.acceptedMapping, currentSource.acceptedMapping);
    assert.equal(executionSource.releaseId, '201');
  });
}

test('GitHub update to a different repository does not inherit installed release metadata', async t => {
  const fixture = managedReplacementFixture(t, {
    provider: 'github',
    currentSource: installedGithubSource(),
    githubIdentity: {
      githubRepositoryId: '102', githubReleaseId: '401', githubOwner: 'Other', githubRepo: 'DifferentPack'
    }
  });

  const reviewed = await fixture.adapter.createPlan({
    request: fixture.request('update'), inspection: fixture.inspection, source: fixture.source
  });

  const executionSource = fixture.adapter.getExecutionRecord(reviewed.plan).source;
  assert.equal(Object.hasOwn(executionSource, 'assetPattern'), false);
  assert.equal(Object.hasOwn(executionSource, 'acceptedMapping'), false);
  assert.equal(executionSource.repositoryId, '102');
});

test('managed replacement reviews pin the current coordinator revision when config writes advanced past managed state', async t => {
  const fixture = managedReplacementFixture(t, { coordinatorRevision: 8 });

  const reviewed = await fixture.adapter.createPlan({
    request: fixture.request('update'), inspection: fixture.inspection, source: fixture.source
  });

  assert.equal(reviewed.plan.operation.expectedContentRevision, 8);
  assert.equal(reviewed.plan.preconditions.contentRevision, 8);
  assert.equal(reviewed.sanitizedView.server.contentRevision, 8);
});

test('source planning reports truthful stage boundaries and forwards candidate activity', async t => {
  const fixture = managedReplacementFixture(t, {
    candidateProgress: {
      activity: 'downloading-pack-files', processedBytes: 5, totalBytes: 10
    }
  });
  const progress = [];

  await fixture.adapter.createPlan({
    request: fixture.request('update'),
    inspection: fixture.inspection,
    source: fixture.source,
    onProgress: event => progress.push(event)
  });

  assert.deepEqual(progress, [
    { phase: 'validating-destination' },
    { phase: 'preparing-candidate' },
    { phase: 'preparing-candidate', activity: 'downloading-pack-files', processedBytes: 5, totalBytes: 10 },
    { phase: 'scanning-server' },
    { phase: 'calculating-changes' },
    { phase: 'checking-capacity' },
    { phase: 'sealing-plan' }
  ]);
  assert.ok(progress.every(Object.isFrozen));
});

test('managed replacement never issues a plan whose server revision changed during asynchronous preparation', async t => {
  let coordinatorRevision = 7;
  const fixture = managedReplacementFixture(t, {
    coordinatorRevision: () => coordinatorRevision,
    duringPrepare() { coordinatorRevision = 8; }
  });

  await assert.rejects(fixture.adapter.createPlan({
    request: fixture.request('update'), inspection: fixture.inspection, source: fixture.source
  }), error => error?.code === 'PLAN_STALE');
});

for (const [provider, operationKind] of [
  ['modrinth', 'update'],
  ['github', 'switch'],
  ['local', 'install-existing']
]) {
  test(`${provider} ${operationKind} cannot disguise an older Minecraft runtime as a non-downgrade replacement`, async t => {
    const fixture = managedReplacementFixture(t, {
      provider,
      currentRuntime: exactRuntime({ minecraftVersion: '1.21.1' }),
      targetRuntime: exactRuntime({ minecraftVersion: '1.20.1' })
    });

    await assert.rejects(fixture.adapter.createPlan({
      request: fixture.request(operationKind), inspection: fixture.inspection, source: fixture.source
    }), error => error?.code === 'DOWNGRADE_REQUIRED' && error?.retryable === true);
  });
}

test('same Minecraft and loader family with an older exact loader version requires downgrade semantics', async t => {
  const fixture = managedReplacementFixture(t, {
    provider: 'github',
    currentRuntime: exactRuntime({ loaderVersion: '0.16.10' }),
    targetRuntime: exactRuntime({ loaderVersion: '0.15.11' })
  });

  await assert.rejects(fixture.adapter.createPlan({
    request: fixture.request('update'), inspection: fixture.inspection, source: fixture.source
  }), error => error?.code === 'DOWNGRADE_REQUIRED');
});

test('Forge loader ordering is preserved across prepared-pack and manifest version representations', async t => {
  const fixture = managedReplacementFixture(t, {
    provider: 'local',
    currentRuntime: exactRuntime({
      minecraftVersion: '1.20.1', loaderFamily: 'forge', loaderVersion: '1.20.1-47.3.0'
    }),
    targetRuntime: exactRuntime({
      minecraftVersion: '1.20.1', loaderFamily: 'forge', loaderVersion: '47.2.0'
    })
  });

  await assert.rejects(fixture.adapter.createPlan({
    request: fixture.request('switch'), inspection: fixture.inspection, source: fixture.source
  }), error => error?.code === 'DOWNGRADE_REQUIRED');
});

test('unequal loader versions outside documented exact formats fail closed', async t => {
  const fixture = managedReplacementFixture(t, {
    currentRuntime: exactRuntime({ loaderVersion: 'custom-current' }),
    targetRuntime: exactRuntime({ loaderVersion: 'custom-target' })
  });

  await assert.rejects(fixture.adapter.createPlan({
    request: fixture.request('update'), inspection: fixture.inspection, source: fixture.source
  }), error => error?.code === 'DOWNGRADE_REQUIRED');
});

test('numeric prerelease identifiers sort below alphabetic prerelease identifiers', async t => {
  const fixture = managedReplacementFixture(t, {
    currentRuntime: exactRuntime({ loaderVersion: '1.0.0-alpha' }),
    targetRuntime: exactRuntime({ loaderVersion: '1.0.0-1' })
  });

  await assert.rejects(fixture.adapter.createPlan({
    request: fixture.request('update'), inspection: fixture.inspection, source: fixture.source
  }), error => error?.code === 'DOWNGRADE_REQUIRED');
});

for (const operationKind of ['update', 'install-existing']) {
  test(`${operationKind} cannot disguise a same-Minecraft loader-family change as a non-switch replacement`, async t => {
    const fixture = managedReplacementFixture(t, {
      provider: operationKind === 'update' ? 'github' : 'local',
      currentRuntime: exactRuntime({ loaderFamily: 'forge', loaderVersion: '47.3.0' }),
      targetRuntime: exactRuntime({ loaderFamily: 'fabric', loaderVersion: '0.16.10' })
    });

    await assert.rejects(fixture.adapter.createPlan({
      request: fixture.request(operationKind), inspection: fixture.inspection, source: fixture.source
    }), error => error?.code === 'SWITCH_REQUIRED' && error?.retryable === true);
  });
}

test('a forward Minecraft update with a different loader family still requires switch semantics', async t => {
  const fixture = managedReplacementFixture(t, {
    currentRuntime: exactRuntime({ minecraftVersion: '1.20.1', loaderFamily: 'forge', loaderVersion: '47.3.0' }),
    targetRuntime: exactRuntime({ minecraftVersion: '1.21.1', loaderFamily: 'fabric', loaderVersion: '0.16.10' })
  });

  await assert.rejects(fixture.adapter.createPlan({
    request: fixture.request('update'), inspection: fixture.inspection, source: fixture.source
  }), error => error?.code === 'SWITCH_REQUIRED');
});

test('an older Minecraft runtime takes downgrade precedence over a simultaneous loader-family change', async t => {
  const fixture = managedReplacementFixture(t, {
    currentRuntime: exactRuntime({ minecraftVersion: '1.21.1', loaderFamily: 'forge', loaderVersion: '47.3.0' }),
    targetRuntime: exactRuntime({ minecraftVersion: '1.20.1', loaderFamily: 'fabric', loaderVersion: '0.16.10' })
  });

  await assert.rejects(fixture.adapter.createPlan({
    request: fixture.request('update'), inspection: fixture.inspection, source: fixture.source
  }), error => error?.code === 'DOWNGRADE_REQUIRED');
});

test('same-family loader advancement remains a valid update', async t => {
  const fixture = managedReplacementFixture(t, {
    currentRuntime: exactRuntime({ loaderVersion: '0.16.10' }),
    targetRuntime: exactRuntime({ loaderVersion: '0.16.11' })
  });

  const result = await fixture.adapter.createPlan({
    request: fixture.request('update'), inspection: fixture.inspection, source: fixture.source
  });
  assert.equal(result.plan.operation.kind, 'upgrade');
  assert.equal(result.plan.operation.downgrade, false);
});

test('a forward Minecraft runtime remains permitted even when its loader version number is lower', async t => {
  const fixture = managedReplacementFixture(t, {
    provider: 'local',
    currentRuntime: exactRuntime({ minecraftVersion: '1.20.1', loaderVersion: '47.3.12' }),
    targetRuntime: exactRuntime({ minecraftVersion: '1.21.1', loaderVersion: '0.16.10' })
  });

  const result = await fixture.adapter.createPlan({
    request: fixture.request('switch'), inspection: fixture.inspection, source: fixture.source
  });
  assert.equal(result.plan.operation.kind, 'switch');
  assert.equal(result.plan.operation.downgrade, false);
});

test('a loader-family switch on the same Minecraft version is not treated as a downgrade', async t => {
  const fixture = managedReplacementFixture(t, {
    currentRuntime: exactRuntime({ loaderFamily: 'forge', loaderVersion: '47.3.12' }),
    targetRuntime: exactRuntime({ loaderFamily: 'fabric', loaderVersion: '0.16.10' })
  });

  const result = await fixture.adapter.createPlan({
    request: fixture.request('switch'), inspection: fixture.inspection, source: fixture.source
  });
  assert.equal(result.plan.operation.kind, 'switch');
  assert.equal(result.plan.operation.downgrade, false);
});

test('an explicit chronological downgrade needs acknowledgement but no prior restore because execution creates one', async t => {
  const currentRuntime = exactRuntime({ minecraftVersion: '1.20.1', loaderVersion: '0.15.11' });
  const targetRuntime = exactRuntime({ minecraftVersion: '1.21.1', loaderVersion: '0.16.10' });
  const fixture = managedReplacementFixture(t, {
    provider: 'modrinth', currentRuntime, targetRuntime, restorePoints: []
  });

  await assert.rejects(fixture.adapter.createPlan({
    request: fixture.request('downgrade'), inspection: fixture.inspection, source: fixture.source
  }), error => error?.code === 'INVALID_REQUEST' && error?.details?.field === 'restorePoints');

  const result = await fixture.adapter.createPlan({
    request: fixture.request('downgrade', { acknowledgeDowngradeWorldRisk: true }),
    inspection: fixture.inspection,
    source: fixture.source
  });
  assert.equal(result.plan.operation.kind, 'downgrade');
  assert.equal(result.plan.operation.downgrade, true);
  assert.equal(result.plan.requirements.downgradeWorldRiskAcknowledged, true);
});

test('guided-review inspection and incoming manifest stay private and become the execution authority', async t => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'minecraft-core-production-plan-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const serverPath = path.join(root, 'Reserved Server');
  fs.mkdirSync(serverPath);
  const reviewedInspection = {
    type: 'archive-inspection', archiveFamily: 'zip', integrity: 'tested',
    selectedRoot: 'server-pack',
    artifactSet: { completeness: 'verified-complete-set', fingerprint: SHA },
    classification: {
      kind: 'prepared-server-pack', confidence: 'exact', blocked: false,
      runtime: {
        minecraftVersion: '1.21.1', loaderFamily: 'fabric', loaderVersion: '0.16.10'
      }
    },
    limitEvidence: { totals: { entryCount: 2, expandedBytes: '2' } }
  };
  const incomingManifest = {
    schemaVersion: 1,
    installationId: 'guided-review-incoming',
    entries: []
  };
  const adapter = adapterFor(serverPath, {
    prepareResult: {
      runtime: {
        minecraftVersion: '1.21.1', loaderFamily: 'fabric', loaderVersion: '0.16.10',
        javaMajor: 21, os: 'win32', architecture: 'x64'
      },
      inspectionResult: reviewedInspection,
      incomingManifest,
      candidateBytes: '2',
      execution: { outputDirectoryId: 'output-reviewed' }
    }
  });
  const unreviewed = inspection();
  unreviewed.result.classification = {
    kind: 'unknown', confidence: 'none', blocked: true, runtime: null
  };

  const result = await adapter.createPlan({
    request: {
      inspectionId: 'inspection-one', instanceId: 'server-one', operationKind: 'install-existing',
      selections: { optionalFileIds: [], conflictChoices: { paths: {}, categories: {} } }
    },
    inspection: unreviewed,
    source: {
      provider: 'modrinth', projectId: 'project-one', versionId: 'version-one',
      version: '1.0.0', title: 'Project One'
    }
  });

  const execution = adapter.getExecutionRecord(result.plan);
  assert.equal(result.plan.inspection.kind, 'prepared-server-pack');
  assert.equal(result.plan.inspection.expandedBytes, '2');
  assert.equal(result.sanitizedView.changes.added, 0);
  assert.deepEqual(execution.incomingManifest, incomingManifest);
  assert.deepEqual(execution.inspectionResult, reviewedInspection);
  assert.equal(Object.hasOwn(result, 'incomingManifest'), false);
  assert.equal(Object.hasOwn(result.sanitizedView, 'inspectionResult'), false);
});

test('install-existing review of an exact empty setup reservation becomes install-new', async t => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'minecraft-core-production-plan-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const serverPath = path.join(root, 'Reserved Server');
  fs.mkdirSync(serverPath);
  const adapter = adapterFor(serverPath);

  const result = await adapter.createPlan({
    request: {
      inspectionId: 'inspection-one', instanceId: 'server-one', operationKind: 'install-existing',
      selections: {
        optionalFileIds: [], conflictChoices: { paths: {}, categories: {} },
        acknowledgeMissingProviderDigest: false, acknowledgeDowngradeWorldRisk: false
      }
    },
    inspection: inspection(),
    source: {
      provider: 'modrinth', projectId: 'project-one', versionId: 'version-one',
      version: '1.0.0', title: 'Project One'
    }
  });

  assert.deepEqual(result.plan.operation, {
    kind: 'install', serverKind: 'new', instanceId: 'server-one',
    expectedContentRevision: 0, downgrade: false
  });
  assert.equal(result.plan.requirements.verifiedRestorePointRequired, false);
  assert.equal(result.plan.selections.maxRam, 4);
  assert.equal(result.plan.selections.serverPort, 25565);
  assert.equal(result.plan.selections.networkAccess, 'pack-default');
  assert.deepEqual(result.sanitizedView.resources, {
    maxRam: 4,
    serverPort: 25565,
    networkAccess: 'pack-default'
  });
  assert.equal(result.sanitizedView.server.priorState, 'new');
  assert.equal(adapter.getExecutionRecord(result.plan).reservation.kind, 'empty-directory');
});

test('install-new preserves explicit reviewed port and loopback access in its plan and review', async t => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'minecraft-core-production-plan-network-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const serverPath = path.join(root, 'Reserved Server');
  fs.mkdirSync(serverPath);
  const adapter = adapterFor(serverPath);

  const result = await adapter.createPlan({
    request: {
      inspectionId: 'inspection-one', instanceId: 'server-network', operationKind: 'install-new',
      selections: {
        optionalFileIds: [], conflictChoices: { paths: {}, categories: {} },
        acknowledgeMissingProviderDigest: false, acknowledgeDowngradeWorldRisk: false,
        maxRam: 7, serverPort: 25571, networkAccess: 'loopback'
      }
    },
    inspection: inspection(),
    source: {
      provider: 'modrinth', projectId: 'project-one', versionId: 'version-one',
      version: '1.0.0', title: 'Project One'
    }
  });

  assert.deepEqual(result.sanitizedView.resources, {
    maxRam: 7,
    serverPort: 25571,
    networkAccess: 'loopback'
  });
  assert.equal(result.plan.selections.serverPort, 25571);
  assert.equal(result.plan.selections.networkAccess, 'loopback');
});

function newServerPlanInput(instanceId, serverPort, networkAccess = 'loopback') {
  return {
    request: {
      inspectionId: 'inspection-one', instanceId, operationKind: 'install-new',
      selections: {
        optionalFileIds: [], conflictChoices: { paths: {}, categories: {} },
        acknowledgeMissingProviderDigest: false, acknowledgeDowngradeWorldRisk: false,
        maxRam: 6, serverPort, networkAccess
      }
    },
    inspection: inspection(),
    source: {
      provider: 'modrinth', projectId: 'project-one', versionId: 'version-one',
      version: '1.0.0', title: 'Project One'
    }
  };
}

async function assertSafeSelectedPortConflict(action, forbiddenText) {
  await assert.rejects(action, error => {
    assert.equal(error.code, 'INVALID_REQUEST');
    assert.equal(error.safeMessage, 'The selected Minecraft server port is already in use. Choose another port and retry.');
    assert.deepEqual(error.details, { field: 'selections.serverPort' });
    const publicResult = error.toPublicResult();
    assert.deepEqual(publicResult.error.details, { field: 'selections.serverPort' });
    assert.doesNotMatch(JSON.stringify(publicResult), forbiddenText);
    return true;
  });
}

test('another saved stopped instance port blocks a new-server plan before candidate preparation', async t => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'minecraft-core-production-plan-saved-port-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const serverPath = path.join(root, 'Reserved Server');
  const privateExistingPath = path.join(root, 'Existing Stopped Server');
  fs.mkdirSync(serverPath);
  let preparationCalls = 0;
  const validationRequests = [];
  const adapter = adapterFor(serverPath, {
    prepared() { preparationCalls += 1; },
    async validateServerPorts(request) {
      validationRequests.push(request);
      return {
        valid: false,
        errors: [{
          type: 'minecraft', scope: 'internal', port: 25571,
          conflictingInstance: { id: 'server-stopped', name: 'Stopped Server', path: privateExistingPath },
          message: `Minecraft port 25571 is already used by ${privateExistingPath}.`
        }]
      };
    }
  });

  await assertSafeSelectedPortConflict(
    () => adapter.createPlan(newServerPlanInput('server-new', 25571)),
    /Existing Stopped Server|Stopped Server|server-stopped/iu
  );

  assert.equal(preparationCalls, 0);
  assert.deepEqual(validationRequests, [{
    instanceId: 'server-new', serverPath, minecraftPort: 25571
  }]);
});

test('an externally occupied port blocks a new-server plan before candidate preparation without exposing process details', async t => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'minecraft-core-production-plan-listener-port-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const serverPath = path.join(root, 'Reserved Server');
  fs.mkdirSync(serverPath);
  let preparationCalls = 0;
  const adapter = adapterFor(serverPath, {
    prepared() { preparationCalls += 1; },
    async validateServerPorts() {
      return {
        valid: false,
        errors: [{
          type: 'minecraft', scope: 'external', port: 25572, code: 'EADDRINUSE',
          process: { pid: 4242, processName: 'private-java.exe' },
          message: 'Minecraft port 25572 is occupied by private-java.exe with PID 4242.'
        }]
      };
    }
  });

  await assertSafeSelectedPortConflict(
    () => adapter.createPlan(newServerPlanInput('server-new', 25572)),
    /4242|private-java|PID/iu
  );

  assert.equal(preparationCalls, 0);
});

test('an available loopback-selected port is validated before candidate preparation and proceeds', async t => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'minecraft-core-production-plan-available-port-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const serverPath = path.join(root, 'Reserved Server');
  fs.mkdirSync(serverPath);
  const order = [];
  const validationRequests = [];
  const adapter = adapterFor(serverPath, {
    prepared() { order.push('prepare'); },
    async validateServerPorts(request) {
      order.push('validate-port');
      validationRequests.push(request);
      return { valid: true, errors: [] };
    }
  });

  const result = await adapter.createPlan(newServerPlanInput('server-new', 25573));

  assert.deepEqual(order, ['validate-port', 'prepare']);
  assert.deepEqual(validationRequests, [{
    instanceId: 'server-new', serverPath, minecraftPort: 25573
  }]);
  assert.equal(result.plan.selections.serverPort, 25573);
  assert.equal(result.plan.selections.networkAccess, 'loopback');
});

test('GitHub review exposes the immutable repository and release identity without exposing execution metadata', async t => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'minecraft-core-production-plan-github-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const serverPath = path.join(root, 'Reserved GitHub Server');
  fs.mkdirSync(serverPath);
  const adapter = adapterFor(serverPath);
  const source = {
    provider: 'github', repositoryId: '101', releaseId: '201',
    githubOwner: 'Owner', githubRepo: 'Pack', version: 'v2.0.0', title: 'Owner/Pack',
    channel: 'release', prerelease: false, publishedAt: '2026-08-01T00:00:00.000Z',
    selectedAssetIds: ['301']
  };

  const result = await adapter.createPlan({
    request: {
      inspectionId: 'inspection-one', instanceId: 'server-github', operationKind: 'install-new',
      selections: {
        optionalFileIds: [], conflictChoices: { paths: {}, categories: {} },
        acknowledgeMissingProviderDigest: true, acknowledgeDowngradeWorldRisk: false
      }
    },
    inspection: githubInspection(),
    source
  });

  assert.deepEqual(result.sanitizedView.source, {
    provider: 'github', repositoryId: '101', releaseId: '201', version: 'v2.0.0'
  });
  assert.equal(result.plan.source.repositoryId, '101');
  assert.equal(result.plan.source.releaseId, '201');
  assert.equal(Object.hasOwn(result.sanitizedView.source, 'githubOwner'), false);
  assert.equal(Object.hasOwn(result.sanitizedView.source, 'selectedAssetIds'), false);
});

test('install-existing reviews and adopts a registered nonempty unmanaged server without changing its files', async t => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'minecraft-core-production-plan-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const serverPath = path.join(root, 'Existing Server');
  fs.mkdirSync(path.join(serverPath, 'world'), { recursive: true });
  fs.writeFileSync(path.join(serverPath, 'server.properties'), 'motd=existing\n');
  fs.writeFileSync(path.join(serverPath, 'world', 'level.dat'), 'world-sentinel');
  const hash = value => crypto.createHash('sha256').update(value).digest('hex');
  const incomingProperties = 'motd=pack\n';
  const incomingMod = 'reviewed-pack-mod';
  const incomingManifest = {
    schemaVersion: 1,
    installationId: 'incoming-adoption',
    entries: [
      {
        path: 'server.properties', pathKey: 'server.properties', origin: 'pack',
        managementPolicy: 'preserve-after-seed', role: 'configuration',
        installedHash: hash(incomingProperties), size: String(Buffer.byteLength(incomingProperties)), priorBaseline: null
      },
      {
        path: 'mods/pack.jar', pathKey: 'mods/pack.jar', origin: 'pack',
        managementPolicy: 'replaceable-managed', role: 'mod',
        installedHash: hash(incomingMod), size: String(Buffer.byteLength(incomingMod)), priorBaseline: null
      }
    ]
  };
  const stateRepository = { read() { return null; } };
  const snapshotServer = createProductionServerSnapshot({ fsApi: fs, reparseInspector, stateRepository });
  const adapter = new ProductionPlanningAdapter({
    instanceResolver: {
      async resolveInstance(instanceId) { return { instanceId, serverPath, priorRunning: false }; }
    },
    stateRepository,
    readContentRevision: () => 7,
    reparseInspector,
    availableBytes: async () => '100000000000',
    validateServerPorts: availablePortValidation,
    preparePlanInputs: async () => ({
      runtime: exactRuntime(), incomingManifest, candidateBytes: '128',
      execution: { outputDirectoryId: 'output-adoption' }
    }),
    snapshotServer
  });

  const request = conflictChoices => ({
    inspectionId: 'inspection-one', instanceId: 'server-one', operationKind: 'install-existing',
    selections: { optionalFileIds: [], conflictChoices }
  });
  const source = {
    provider: 'modrinth', projectId: 'project-one', versionId: 'version-one',
    version: '1.0.0', title: 'Project One'
  };

  const review = await adapter.createPlan({
    request: request({ paths: {}, categories: {} }), inspection: inspection(), source
  });
  assert.equal(review.requiresConflictReview, true);
  assert.equal(review.conflicts.length, 1);
  assert.equal(review.conflicts[0].label, 'server.properties');
  assert.deepEqual(review.conflicts[0].allowedChoices, ['keep-mine', 'use-pack', 'keep-both']);

  const result = await adapter.createPlan({
    request: request({
      paths: { [review.conflicts[0].id]: { choice: 'keep-mine' } },
      categories: {}
    }),
    inspection: inspection(),
    source
  });

  assert.deepEqual(result.plan.operation, {
    kind: 'install', serverKind: 'existing', instanceId: 'server-one',
    expectedContentRevision: 7, downgrade: false
  });
  assert.equal(result.plan.requirements.verifiedRestorePointRequired, true);
  assert.equal(result.sanitizedView.server.priorState, 'existing');
  assert.equal(result.plan.ownership.actions.find(entry => entry.pathKey === 'server.properties').action, 'preserve-modified');
  assert.equal(result.plan.ownership.actions.find(entry => entry.pathKey === 'world/level.dat').action, 'preserve-user-addon');
  assert.equal(result.plan.ownership.actions.find(entry => entry.pathKey === 'mods/pack.jar').action, 'add');
  assert.equal(adapter.getExecutionRecord(result.plan).adoption.kind, 'existing-unmanaged-directory');
  assert.equal(fs.readFileSync(path.join(serverPath, 'server.properties'), 'utf8'), 'motd=existing\n');
  assert.equal(fs.readFileSync(path.join(serverPath, 'world', 'level.dat'), 'utf8'), 'world-sentinel');

  fs.mkdirSync(path.join(serverPath, 'mods'));
  fs.writeFileSync(path.join(serverPath, 'mods', 'pack.jar'), 'detached-user-mod');
  const detachedState = {
    state: {
      modpackManaged: false,
      contentRevision: 7,
      runtime: exactRuntime(),
      installedAt: '2026-07-01T00:00:00.000Z'
    },
    manifest: {
      schemaVersion: 1,
      installationId: 'detached-old-pack',
      entries: [
        {
          path: 'server.properties', pathKey: 'server.properties', origin: 'pack',
          managementPolicy: 'replaceable-managed', role: 'configuration',
          installedHash: hash('motd=existing\n'), size: String(Buffer.byteLength('motd=existing\n')), priorBaseline: null
        },
        {
          path: 'mods/pack.jar', pathKey: 'mods/pack.jar', origin: 'pack',
          managementPolicy: 'replaceable-managed', role: 'mod',
          installedHash: hash('detached-user-mod'), size: String(Buffer.byteLength('detached-user-mod')), priorBaseline: null
        }
      ]
    }
  };
  const detachedRepository = { read() { return detachedState; } };
  const detachedAdapter = new ProductionPlanningAdapter({
    instanceResolver: {
      async resolveInstance(instanceId) { return { instanceId, serverPath, priorRunning: false }; }
    },
    stateRepository: detachedRepository,
    readContentRevision: () => 7,
    reparseInspector,
    availableBytes: async () => '100000000000',
    validateServerPorts: availablePortValidation,
    preparePlanInputs: async () => ({
      runtime: exactRuntime(), incomingManifest, candidateBytes: '128',
      execution: { outputDirectoryId: 'output-detached-adoption' }
    }),
    snapshotServer: createProductionServerSnapshot({
      fsApi: fs, reparseInspector, stateRepository: detachedRepository
    })
  });
  const detachedReview = await detachedAdapter.createPlan({
    request: request({ paths: {}, categories: {} }), inspection: inspection(), source
  });
  assert.equal(detachedReview.requiresConflictReview, true);
  assert.deepEqual(detachedReview.conflicts.map(conflict => conflict.label).sort(), ['mods/pack.jar', 'server.properties']);
});

test('install-new still rejects a registered nonempty unmanaged target before archive candidate preparation', async t => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'minecraft-core-production-plan-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const serverPath = path.join(root, 'Existing Server');
  fs.mkdirSync(serverPath);
  fs.writeFileSync(path.join(serverPath, 'server.properties'), 'motd=existing\n');
  let prepared = false;
  const adapter = adapterFor(serverPath, { prepared() { prepared = true; } });

  await assert.rejects(adapter.createPlan({
    request: {
      inspectionId: 'inspection-one', instanceId: 'server-one', operationKind: 'install-new',
      selections: { optionalFileIds: [], conflictChoices: { paths: {}, categories: {} } }
    },
    inspection: inspection(),
    source: {
      provider: 'modrinth', projectId: 'project-one', versionId: 'version-one',
      version: '1.0.0', title: 'Project One'
    }
  }), error => error?.code === 'TARGET_EXISTS');
  assert.equal(prepared, false);
  assert.equal(fs.readFileSync(path.join(serverPath, 'server.properties'), 'utf8'), 'motd=existing\n');
});

test('safe files-only planning carries no invented runtime and maps the new-server operation', async t => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'minecraft-core-production-plan-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const serverPath = path.join(root, 'Reserved Files');
  fs.mkdirSync(serverPath);
  const effectiveResult = {
    ...inspection().result,
    classification: { kind: 'files-only', confidence: 'exact', blocked: false },
    limitEvidence: { totals: { entryCount: 1, expandedBytes: '1' } }
  };
  const adapter = adapterFor(serverPath, {
    prepareResult: {
      runtime: null,
      incomingManifest: { schemaVersion: 1, installationId: 'incoming-files', entries: [] },
      candidateBytes: '1', execution: { outputDirectoryId: 'output-files' }, inspectionResult: effectiveResult
    }
  });
  const result = await adapter.createPlan({
    request: {
      inspectionId: 'inspection-one', instanceId: 'server-files', operationKind: 'import-files-only-new',
      selections: {
        optionalFileIds: [], conflictChoices: { paths: {}, categories: {} },
        acknowledgeMissingProviderDigest: false, acknowledgeDowngradeWorldRisk: false,
        selectedRoot: null, runtimeChoice: null
      }
    },
    inspection: inspection(),
    source: {
      provider: 'modrinth', projectId: 'project-one', versionId: 'version-one',
      version: '1.0.0', title: 'Project One'
    }
  });

  assert.equal(result.plan.operation.kind, 'files-only');
  assert.equal(result.plan.runtime, null);
  assert.equal(result.sanitizedView.runtime, null);
  assert.equal(result.plan.requirements.filesOnlySafetyConfirmed, true);
});

function conflictAdapter(serverPath, {
  selectedOptionalFiles = [], snapshotCandidateBytes = null, availableBytes = '100000000000'
} = {}) {
  const runtime = {
    minecraftVersion: '1.21.1', loaderFamily: 'fabric', loaderVersion: '0.16.10',
    javaMajor: 21, os: 'win32', architecture: 'x64'
  };
  const oldEntry = {
    path: 'config/changed.toml', pathKey: 'config/changed.toml', origin: 'pack',
    managementPolicy: 'replaceable-managed', role: 'configuration',
    installedHash: '1'.repeat(64), size: '1', priorBaseline: null
  };
  return new ProductionPlanningAdapter({
    instanceResolver: { async resolveInstance(instanceId) { return { instanceId, serverPath, priorRunning: false }; } },
    stateRepository: {
      read() {
        return {
          state: {
            modpackManaged: true, contentRevision: 7, runtime,
            selectedOptionalFiles,
            source: {
              provider: 'modrinth', projectId: 'project-one', versionId: 'version-one',
              version: '1.0.0', title: 'Project One'
            }
          },
          manifest: { schemaVersion: 1, installationId: 'installed-one', entries: [oldEntry] }
        };
      }
    },
    reparseInspector,
    availableBytes: async () => availableBytes,
    validateServerPorts: availablePortValidation,
    preparePlanInputs: async () => ({
      runtime,
      incomingManifest: {
        schemaVersion: 1, installationId: 'incoming-two',
        entries: [{ ...oldEntry, installedHash: '2'.repeat(64) }]
      },
      candidateBytes: '1', execution: { outputDirectoryId: 'output-conflict' }
    }),
    snapshotServer: async () => ({
      liveSnapshot: {
        kind: 'existing', worldDirectories: ['world'], protectedPaths: [],
        entries: [{
          path: oldEntry.path, pathKey: oldEntry.pathKey, type: 'file',
          sha256: '3'.repeat(64), size: '1'
        }]
      },
      pathPreconditions: [], sourceRuntime: runtime,
      ...(snapshotCandidateBytes === null ? {} : { candidateBytes: snapshotCandidateBytes })
    })
  });
}

function conflictRequest(conflictChoices = { paths: {}, categories: {} }) {
  return {
    inspectionId: 'inspection-one', instanceId: 'server-one', operationKind: 'update',
    selections: {
      optionalFileIds: [], conflictChoices,
      acknowledgeMissingProviderDigest: false, acknowledgeDowngradeWorldRisk: false,
      selectedRoot: null, runtimeChoice: null
    }
  };
}

const conflictSource = Object.freeze({
  provider: 'modrinth', projectId: 'project-one', versionId: 'version-one',
  version: '1.0.0', title: 'Project One'
});

test('existing-server conflicts are reviewed through opaque IDs and resolved on a second preflight', async t => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'minecraft-core-production-conflicts-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const serverPath = path.join(root, 'Managed Server');
  fs.mkdirSync(serverPath);
  const adapter = conflictAdapter(serverPath);

  const review = await adapter.createPlan({
    request: conflictRequest(), inspection: inspection(), source: conflictSource
  });
  assert.equal(review.requiresConflictReview, true);
  assert.equal(Object.hasOwn(review, 'plan'), false);
  assert.equal(review.conflicts.length, 1);
  assert.doesNotMatch(review.conflicts[0].id, /config|changed|toml/i);
  assert.equal(review.conflicts[0].label, 'config/changed.toml');
  assert.deepEqual(review.conflicts[0].allowedChoices, ['keep-mine', 'use-pack', 'keep-both']);
  assert.equal(review.conflicts[0].alternateOptions.length, 1);
  assert.doesNotMatch(review.conflicts[0].alternateOptions[0].id, /config|changed|toml/i);

  const resolved = await adapter.createPlan({
    request: conflictRequest({
      paths: { [review.conflicts[0].id]: { choice: 'use-pack' } },
      categories: {}
    }),
    inspection: inspection(),
    source: conflictSource
  });
  assert.equal(resolved.plan.ownership.blocked.length, 0);
  assert.equal(resolved.plan.ownership.actions[0].action, 'replace');
});

test('forged opaque conflict and alternate IDs fail closed', async t => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'minecraft-core-production-conflicts-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const serverPath = path.join(root, 'Managed Server');
  fs.mkdirSync(serverPath);
  const adapter = conflictAdapter(serverPath);
  const review = await adapter.createPlan({
    request: conflictRequest(), inspection: inspection(), source: conflictSource
  });

  await assert.rejects(adapter.createPlan({
    request: conflictRequest({ paths: { 'conflict-forged': { choice: 'use-pack' } }, categories: {} }),
    inspection: inspection(), source: conflictSource
  }), error => error?.code === 'INVALID_REQUEST');
  await assert.rejects(adapter.createPlan({
    request: conflictRequest({
      paths: {
        [review.conflicts[0].id]: { choice: 'keep-both', alternateId: 'alternate-forged' }
      },
      categories: {}
    }),
    inspection: inspection(), source: conflictSource
  }), error => error?.code === 'INVALID_REQUEST');
});

test('existing-server disk review includes the full live sibling candidate as well as incoming pack bytes', async t => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'minecraft-core-production-disk-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const serverPath = path.join(root, 'Large World Server');
  fs.mkdirSync(serverPath);
  const adapter = conflictAdapter(serverPath, {
    snapshotCandidateBytes: '100000000',
    availableBytes: '2200000000'
  });
  const review = await adapter.createPlan({
    request: conflictRequest(), inspection: inspection(), source: conflictSource
  });

  await assert.rejects(adapter.createPlan({
    request: conflictRequest({
      paths: { [review.conflicts[0].id]: { choice: 'use-pack' } },
      categories: {}
    }),
    inspection: inspection(),
    source: conflictSource
  }), error => error?.code === 'INSUFFICIENT_DISK');
});

test('source planning retains the reviewed server-only disk components for execution revalidation', async t => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'minecraft-core-production-disk-record-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const serverPath = path.join(root, 'Managed Server');
  fs.mkdirSync(serverPath);
  const adapter = conflictAdapter(serverPath, {
    snapshotCandidateBytes: '100',
    availableBytes: '100000000000'
  });
  const conflictReview = await adapter.createPlan({
    request: conflictRequest(), inspection: inspection(), source: conflictSource
  });
  const result = await adapter.createPlan({
    request: conflictRequest({
      paths: { [conflictReview.conflicts[0].id]: { choice: 'use-pack' } },
      categories: {}
    }),
    inspection: inspection(),
    source: conflictSource
  });

  assert.deepEqual(adapter.getExecutionRecord(result.plan).reviewedServerDisk, {
    candidateBytes: '100',
    restorePointBytes: '0',
    rollbackBytes: '0',
    journalBytes: '1048576'
  });
});

test('opted-in GitHub asset review compiles and binds the versioned pattern into plan and execution state', async t => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'minecraft-core-production-pattern-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const serverPath = path.join(root, 'Reserved Server');
  fs.mkdirSync(serverPath);
  const adapter = adapterFor(serverPath);
  const source = {
    provider: 'github', repositoryId: '101', releaseId: '201', githubOwner: 'Owner', githubRepo: 'Pack',
    version: 'v2.0.0', title: 'Pack', selectedAssetIds: ['301'], rememberAssetPattern: true,
    assetPatternSeed: {
      fileNames: ['pack-v2.0.0.mrpack'],
      multipartStructure: { kind: 'single', groupingScheme: 'single', partCount: 1, primaryIndex: 0 }
    }
  };
  const result = await adapter.createPlan({
    request: {
      inspectionId: 'inspection-one', instanceId: 'server-one', operationKind: 'install-existing',
      selections: {
        optionalFileIds: [], conflictChoices: { paths: {}, categories: {} },
        acknowledgeMissingProviderDigest: true, selectedRoot: null, runtimeChoice: null
      }
    },
    inspection: githubInspection(),
    source
  });

  const executionSource = adapter.getExecutionRecord(result.plan).source;
  assert.equal(executionSource.assetPattern.type, 'github-asset-pattern');
  assert.deepEqual(executionSource.assetPattern.filenameMatchers, [{
    kind: 'single-wildcard', prefix: 'pack-v', suffix: '.mrpack'
  }]);
  assert.match(result.plan.preconditions.assetPatternFingerprint, /^[a-f0-9]{64}$/);
  assert.equal(Object.hasOwn(executionSource, 'rememberAssetPattern'), false);
  assert.equal(Object.hasOwn(executionSource, 'assetPatternSeed'), false);
});

function managementFixture(t, {
  restoreTotalBytes = '3',
  restoreArchiveBytes = 3,
  availableBytes = null,
  readContentRevision = () => 0,
  duringAvailableBytes = null,
  duringResolveRestorePoint = null,
  restoreProgress = []
} = {}) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'minecraft-core-production-management-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const serverPath = path.join(root, 'Managed Server');
  fs.mkdirSync(serverPath);
  const runtime = {
    minecraftVersion: '1.21.1', loaderFamily: 'fabric', loaderVersion: '0.16.10',
    javaMajor: 21, os: 'win32', architecture: 'x64'
  };
  const cleanHash = '1'.repeat(64);
  const oldModifiedHash = '2'.repeat(64);
  const liveModifiedHash = '3'.repeat(64);
  const worldHash = '4'.repeat(64);
  const currentState = {
    state: {
      schemaVersion: 1,
      installationId: 'installed-one',
      modpackManaged: true,
      lifecycleMode: 'managed',
      source: {
        provider: 'modrinth', projectId: 'project-one', versionId: 'version-one',
        version: '1.0.0', title: 'Project One'
      },
      runtime,
      selectedOptionalFiles: [],
      installedAt: '2026-08-01T00:00:00.000Z',
      contentRevision: 7
    },
    manifest: {
      schemaVersion: 1,
      installationId: 'installed-one',
      entries: [
        {
          path: 'mods/clean.jar', pathKey: 'mods/clean.jar', origin: 'pack',
          managementPolicy: 'replaceable-managed', role: 'mod', installedHash: cleanHash,
          size: '1', priorBaseline: null
        },
        {
          path: 'config/modified.toml', pathKey: 'config/modified.toml', origin: 'pack',
          managementPolicy: 'replaceable-managed', role: 'configuration', installedHash: oldModifiedHash,
          size: '1', priorBaseline: null
        },
        {
          path: 'world/level.dat', pathKey: 'world/level.dat', origin: 'user',
          managementPolicy: 'protected', role: 'world', installedHash: worldHash,
          size: '1', priorBaseline: null
        }
      ]
    }
  };
  const publicRestorePoint = {
    id: 'restore-selected', sha256: '5'.repeat(64), sourceRevision: 6,
    runtime, worldIncluded: true, totalBytes: restoreTotalBytes
  };
  const privateRestorePoint = {
    ...publicRestorePoint,
    name: 'restore-point-selected.zip', size: restoreArchiveBytes, scopeSha256: '6'.repeat(64),
    sourceRuntime: runtime, operationId: 'operation-selected',
    createdAt: '2026-08-01T00:00:00.000Z', serverPath,
    archivePath: path.join(serverPath, 'backups', 'restore-point-selected.zip'),
    metadataPath: path.join(serverPath, 'backups', 'restore-point-selected.json')
  };
  const owners = [];
  const workspaceRegistry = {
    createPlanningSession() {
      const id = `planning-management-${owners.length + 1}`;
      owners.push(id);
      return id;
    },
    createStagingOutput({ ownerId }) {
      assert.equal(ownerId, owners.at(-1));
      return `output-management-${owners.length}`;
    },
    releaseOwner() { return 1; }
  };
  const adapter = new ProductionPlanningAdapter({
    instanceResolver: { async resolveInstance(instanceId) { return { instanceId, serverPath, priorRunning: false }; } },
    stateRepository: { read() { return currentState; } },
    readContentRevision,
    reparseInspector,
    validateServerPorts: availablePortValidation,
    preparePlanInputs: async () => { throw new Error('management planning must not prepare a source candidate'); },
    snapshotServer: async () => ({
      liveSnapshot: {
        kind: 'existing', worldDirectories: ['world'], protectedPaths: [],
        entries: [
          { path: 'mods/clean.jar', pathKey: 'mods/clean.jar', type: 'file', sha256: cleanHash, size: '1' },
          { path: 'config/modified.toml', pathKey: 'config/modified.toml', type: 'file', sha256: liveModifiedHash, size: '1' },
          { path: 'world/level.dat', pathKey: 'world/level.dat', type: 'file', sha256: worldHash, size: '1' },
          { path: 'notes.txt', pathKey: 'notes.txt', type: 'file', sha256: '7'.repeat(64), size: '1' }
        ]
      },
      pathPreconditions: [], sourceRuntime: runtime, candidateBytes: '4', restorePointBytes: '4',
      rollbackBytes: '4', journalBytes: '1', writeable: true, restorePoints: [publicRestorePoint]
    }),
    ...(availableBytes === null ? {} : {
      availableBytes: async () => {
        if (duringAvailableBytes) await duringAvailableBytes();
        return availableBytes;
      }
    }),
    workspaceRegistry,
    resolveRestorePoint: async ({ id, sha256, serverPath: requestedPath }, options = {}) => {
      assert.equal(requestedPath, serverPath);
      assert.equal(id, publicRestorePoint.id);
      assert.equal(sha256, publicRestorePoint.sha256);
      if (duringResolveRestorePoint) await duringResolveRestorePoint();
      for (const progress of restoreProgress) options.onProgress?.(progress);
      return privateRestorePoint;
    }
  });
  return { adapter, currentState, privateRestorePoint, publicRestorePoint, runtime, serverPath };
}

test('detach planning is a zero-file state transition with a transferable private workspace', async t => {
  const fixture = managementFixture(t);
  const result = await fixture.adapter.createManagementPlan({
    request: { instanceId: 'server-one', operationKind: 'detach', selectionRef: null },
    currentState: fixture.currentState,
    instance: { instanceId: 'server-one', serverPath: fixture.serverPath }
  });

  assert.match(result.planningSessionId, /^planning-management-/);
  assert.deepEqual(result.plan.operation, {
    kind: 'detach', serverKind: 'existing', instanceId: 'server-one', expectedContentRevision: 7, downgrade: false
  });
  assert.deepEqual(result.sanitizedView.changes, { added: 0, changed: 0, removed: 0, preserved: 4 });
  assert.equal(result.plan.ownership.actions.length, 0);
  assert.equal(result.plan.requirements.verifiedRestorePointRequired, true);
  assert.equal(result.plan.disk.candidateBytes, '4');
  assert.equal(result.plan.disk.restorePointBytes, '4');
  assert.equal(result.plan.disk.rollbackBytes, '4');
  assert.equal(BigInt(result.plan.disk.requiredBytes) > 13n, true);
  assert.equal(result.plan.fingerprint.length, 64);
  const executionRecord = fixture.adapter.getExecutionRecord(result.plan);
  assert.equal(executionRecord.operationKind, 'detach');
  assert.deepEqual(executionRecord.reviewedServerDisk, {
    candidateBytes: '4', restorePointBytes: '4', rollbackBytes: '4', journalBytes: '1'
  });

  const replanned = await fixture.adapter.createManagementPlan({
    request: { instanceId: 'server-one', operationKind: 'detach', selectionRef: null },
    currentState: fixture.currentState,
    instance: { instanceId: 'server-one', serverPath: fixture.serverPath }
  });
  assert.notEqual(replanned.plan.fingerprint, result.plan.fingerprint);
  assert.equal(fixture.adapter.getExecutionRecord(replanned.plan).operationKind, 'detach');
});

test('detach planning fails closed when the coordinator revision changes during asynchronous disk preflight', async t => {
  let coordinatorRevision = 7;
  const fixture = managementFixture(t, {
    availableBytes: '100000000000',
    readContentRevision: () => coordinatorRevision,
    async duringAvailableBytes() {
      await Promise.resolve();
      coordinatorRevision = 8;
    }
  });

  await assert.rejects(fixture.adapter.createManagementPlan({
    request: { instanceId: 'server-one', operationKind: 'detach', selectionRef: null },
    currentState: fixture.currentState,
    instance: { instanceId: 'server-one', serverPath: fixture.serverPath }
  }), error => error?.code === 'PLAN_STALE');
});

test('managed uninstall removes only unchanged managed files and preserves modified, user, and world content', async t => {
  const fixture = managementFixture(t);
  const result = await fixture.adapter.createManagementPlan({
    request: { instanceId: 'server-one', operationKind: 'uninstall', selectionRef: null },
    currentState: fixture.currentState,
    instance: { instanceId: 'server-one', serverPath: fixture.serverPath }
  });

  assert.deepEqual(result.plan.ownership.removed.map(item => item.path), ['mods/clean.jar']);
  assert.equal(result.plan.ownership.actions.find(item => item.path === 'config/modified.toml').action, 'preserve-orphan');
  assert.equal(result.plan.ownership.actions.find(item => item.path === 'world/level.dat').action, 'preserve-orphan');
  assert.equal(result.plan.ownership.actions.find(item => item.path === 'notes.txt').action, 'preserve-user-addon');
  assert.deepEqual(result.plan.ownership.confirmation, {
    unchangedManagedRemovalCount: '1',
    preservedCategories: ['configuration', 'other', 'world'],
    possibleNonRunnable: true,
    instanceRetained: true,
    worldsRetained: true
  });
  assert.equal(result.sanitizedView.confirmation.unchangedManagedRemovalCount, '1');
  assert.equal(fixture.adapter.getExecutionRecord(result.plan).operationKind, 'uninstall');
});

test('rollback planning binds the exact selected public point to one private verified reference', async t => {
  const fixture = managementFixture(t);
  const result = await fixture.adapter.createManagementPlan({
    request: { instanceId: 'server-one', operationKind: 'rollback-restore-point', selectionRef: 'restore-selected' },
    currentState: fixture.currentState,
    instance: { instanceId: 'server-one', serverPath: fixture.serverPath }
  });

  assert.deepEqual(result.plan.restorePoints, [fixture.publicRestorePoint]);
  assert.equal(result.sanitizedView.rollback.id, 'restore-selected');
  const execution = fixture.adapter.getExecutionRecord(result.plan);
  assert.equal(execution.operationKind, 'rollback-restore-point');
  assert.deepEqual(execution.selectedRestorePoint, fixture.privateRestorePoint);

  await assert.rejects(fixture.adapter.createManagementPlan({
    request: { instanceId: 'server-one', operationKind: 'rollback-restore-point', selectionRef: 'restore-forged' },
    currentState: fixture.currentState,
    instance: { instanceId: 'server-one', serverPath: fixture.serverPath }
  }), error => error?.code === 'PLAN_STALE');
});

test('management rollback planning reports ordered phases and one monotonic restore verification range', async t => {
  const fixture = managementFixture(t, {
    restoreTotalBytes: '3',
    restoreArchiveBytes: 3,
    restoreProgress: [
      { phase: 'archive-hash', hashPass: 'initial', kind: 'start', processedBytes: 0, totalBytes: 3 },
      { phase: 'archive-hash', hashPass: 'initial', kind: 'progress', processedBytes: 1, totalBytes: 3 },
      { phase: 'archive-hash', hashPass: 'initial', kind: 'progress', processedBytes: 3, totalBytes: 3 },
      { phase: 'entry-verify', kind: 'start', processedBytes: 0, totalBytes: 3 },
      { phase: 'entry-verify', kind: 'progress', processedBytes: 1, totalBytes: 3 },
      { phase: 'entry-verify', kind: 'progress', processedBytes: 3, totalBytes: 3 },
      { phase: 'archive-hash', hashPass: 'final', kind: 'start', processedBytes: 0, totalBytes: 3 },
      { phase: 'archive-hash', hashPass: 'final', kind: 'progress', processedBytes: 3, totalBytes: 3 }
    ]
  });
  const progress = [];

  await fixture.adapter.createManagementPlan({
    request: { instanceId: 'server-one', operationKind: 'rollback-restore-point', selectionRef: 'restore-selected' },
    currentState: fixture.currentState,
    instance: { instanceId: 'server-one', serverPath: fixture.serverPath },
    onProgress: event => progress.push(event)
  });

  assert.deepEqual(progress.map(event => event.phase), [
    'scanning-server',
    'verifying-restore-point',
    'verifying-restore-point',
    'verifying-restore-point',
    'verifying-restore-point',
    'verifying-restore-point',
    'verifying-restore-point',
    'verifying-restore-point',
    'calculating-changes',
    'checking-capacity',
    'sealing-plan'
  ]);
  assert.deepEqual(
    progress.filter(event => Number.isSafeInteger(event.processedBytes))
      .map(event => [event.processedBytes, event.totalBytes]),
    [[0, 6], [1, 6], [3, 6], [3, 6], [4, 6], [6, 6]]
  );
});

test('rollback planning fails closed when the coordinator revision changes during restore-point resolution', async t => {
  let coordinatorRevision = 7;
  const fixture = managementFixture(t, {
    readContentRevision: () => coordinatorRevision,
    async duringResolveRestorePoint() {
      await Promise.resolve();
      coordinatorRevision = 8;
    }
  });

  await assert.rejects(fixture.adapter.createManagementPlan({
    request: { instanceId: 'server-one', operationKind: 'rollback-restore-point', selectionRef: 'restore-selected' },
    currentState: fixture.currentState,
    instance: { instanceId: 'server-one', serverPath: fixture.serverPath }
  }), error => error?.code === 'PLAN_STALE');
});

test('rollback disk preflight budgets one promoted restore tree plus candidate, safety restore, journal, and reserve bytes', async t => {
  const fixture = managementFixture(t, {
    restoreTotalBytes: '1000000000',
    restoreArchiveBytes: 3,
    availableBytes: '3147483661'
  });

  const result = await fixture.adapter.createManagementPlan({
    request: { instanceId: 'server-one', operationKind: 'rollback-restore-point', selectionRef: 'restore-selected' },
    currentState: fixture.currentState,
    instance: { instanceId: 'server-one', serverPath: fixture.serverPath }
  });

  assert.deepEqual(result.plan.disk, {
    candidateBytes: '4',
    restorePointBytes: '4',
    rollbackBytes: '4',
    journalBytes: '1',
    selectedArchiveBytes: '3',
    selectedExpandedBytes: '1000000000',
    selectedExtractionBytes: '1000000000',
    selectedFinalPayloadBytes: '1000000000',
    selectedBytes: '1000000000',
    reserveBytes: '2147483648',
    requiredBytes: '3147483661',
    availableBytes: '3147483661'
  });
});

test('rollback disk preflight still rejects capacity one byte below the complete single-tree budget', async t => {
  const fixture = managementFixture(t, {
    restoreTotalBytes: '1000000000',
    restoreArchiveBytes: 3,
    availableBytes: '3147483660'
  });

  await assert.rejects(fixture.adapter.createManagementPlan({
    request: { instanceId: 'server-one', operationKind: 'rollback-restore-point', selectionRef: 'restore-selected' },
    currentState: fixture.currentState,
    instance: { instanceId: 'server-one', serverPath: fixture.serverPath }
  }), error => {
    assert.equal(error?.code, 'INSUFFICIENT_DISK');
    assert.deepEqual(error.details, {
      requiredBytes: '3147483661',
      availableBytes: '3147483660'
    });
    return true;
  });
});

test('repair is accepted only through reviewed source planning for the exact installed source and runtime', async t => {
  const fixture = managementFixture(t);
  await assert.rejects(fixture.adapter.createManagementPlan({
    request: { instanceId: 'server-one', operationKind: 'repair', selectionRef: null },
    currentState: fixture.currentState,
    instance: { instanceId: 'server-one', serverPath: fixture.serverPath }
  }), error => error?.code === 'INVALID_REQUEST');

  const adapter = conflictAdapter(fixture.serverPath);
  const request = {
    ...conflictRequest(),
    operationKind: 'repair'
  };
  await assert.rejects(adapter.createPlan({
    request,
    inspection: inspection(),
    source: { ...conflictSource, versionId: 'different-version', version: '2.0.0' }
  }), error => error?.code === 'PLAN_STALE');

  const optionalAdapter = conflictAdapter(fixture.serverPath, {
    selectedOptionalFiles: ['optional-installed']
  });
  await assert.rejects(optionalAdapter.createPlan({
    request: {
      ...request,
      selections: { ...request.selections, optionalFileIds: [] }
    },
    inspection: inspection(),
    source: conflictSource
  }), error => error?.code === 'PLAN_STALE');
  await assert.rejects(optionalAdapter.createPlan({
    request: {
      ...request,
      selections: { ...request.selections, optionalFileIds: ['optional-installed', 'optional-new'] }
    },
    inspection: inspection(),
    source: conflictSource
  }), error => error?.code === 'PLAN_STALE');

  await assert.rejects(
    adapter.createPlan({ request, inspection: inspection(), source: conflictSource }),
    error => error?.code === 'PLAN_STALE'
  );
});

test('repair pre-scans the live server and plans only missing or corrupt managed files while preserving healthy runtime', async t => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'minecraft-core-targeted-repair-plan-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const serverPath = path.join(root, 'Managed Server');
  fs.mkdirSync(serverPath);
  const runtime = {
    minecraftVersion: '1.21.1', loaderFamily: 'fabric', loaderVersion: '0.16.10',
    javaMajor: 21, os: 'win32', architecture: 'x64'
  };
  const entry = (entryPath, hash, origin, role) => ({
    path: entryPath, pathKey: entryPath.toLocaleLowerCase('en-US'), origin,
    managementPolicy: 'replaceable-managed', role, installedHash: hash, size: '1', priorBaseline: null
  });
  const runtimeEntry = entry('server.jar', '1'.repeat(64), 'runtime', 'server');
  const missingMod = entry('mods/missing.jar', '2'.repeat(64), 'pack', 'mod');
  const corruptConfig = entry('config/corrupt.toml', '3'.repeat(64), 'pack', 'configuration');
  const currentState = {
    state: {
      modpackManaged: true, contentRevision: 4, runtime, selectedOptionalFiles: [],
      source: {
        provider: 'modrinth', projectId: 'project-one', versionId: 'version-one',
        version: '1.0.0', title: 'Project One'
      }
    },
    manifest: {
      schemaVersion: 1, installationId: 'installation-current',
      entries: [runtimeEntry, missingMod, corruptConfig]
    }
  };
  const liveSnapshot = {
    kind: 'existing', worldDirectories: ['world'], protectedPaths: [],
    entries: [
      { path: 'server.jar', pathKey: 'server.jar', type: 'file', sha256: runtimeEntry.installedHash, size: '1' },
      { path: 'config/corrupt.toml', pathKey: 'config/corrupt.toml', type: 'file', sha256: '4'.repeat(64), size: '1' }
    ]
  };
  let preparationContext = null;
  let resolveSnapshotGate;
  let signalSnapshotStarted;
  const snapshotGate = new Promise(resolve => { resolveSnapshotGate = resolve; });
  const snapshotStarted = new Promise(resolve => { signalSnapshotStarted = resolve; });
  let snapshotCalls = 0;
  const progress = [];
  const adapter = new ProductionPlanningAdapter({
    instanceResolver: { async resolveInstance(instanceId) { return { instanceId, serverPath, priorRunning: false }; } },
    stateRepository: { read() { return currentState; } },
    reparseInspector,
    availableBytes: async () => '100000000000',
    validateServerPorts: availablePortValidation,
    preparePlanInputs: async context => {
      preparationContext = context;
      return {
        runtime,
        incomingManifest: {
          schemaVersion: 1, installationId: 'installation-repair',
          entries: [runtimeEntry, missingMod, corruptConfig]
        },
        candidateBytes: '2',
        execution: { templateOutputId: 'output-repair' }
      };
    },
    snapshotServer: async () => {
      snapshotCalls += 1;
      signalSnapshotStarted();
      await snapshotGate;
      return {
        liveSnapshot, pathPreconditions: [], candidateBytes: '2', restorePointBytes: '2',
        rollbackBytes: '2', journalBytes: '1', sourceRuntime: runtime, restorePoints: [], writeable: true
      };
    }
  });
  const request = {
    inspectionId: 'inspection-one', instanceId: 'server-one', operationKind: 'repair',
    selections: {
      optionalFileIds: [], conflictChoices: { paths: {}, categories: {} },
      acknowledgeMissingProviderDigest: false, acknowledgeDowngradeWorldRisk: false,
      selectedRoot: null, runtimeChoice: null
    }
  };

  const planning = adapter.createPlan({
    request, inspection: inspection(), source: conflictSource, onProgress: event => progress.push(event)
  });
  await snapshotStarted;
  assert.deepEqual(progress.map(event => event.phase), ['validating-destination', 'scanning-server']);
  assert.equal(preparationContext, null);
  resolveSnapshotGate();
  const result = await planning;
  assert.equal(snapshotCalls, 1);
  assert.equal(progress.filter(event => event.phase === 'scanning-server').length, 1);
  const actions = Object.fromEntries(result.plan.ownership.actions.map(action => [action.path, action.action]));
  assert.equal(preparationContext.currentState, currentState);
  assert.equal(preparationContext.liveSnapshot, liveSnapshot);
  assert.deepEqual(actions, {
    'config/corrupt.toml': 'replace',
    'mods/missing.jar': 'restore-missing',
    'server.jar': 'unchanged'
  });
  assert.deepEqual(result.sanitizedView.changes, { added: 1, changed: 1, removed: 0, preserved: 1 });

  liveSnapshot.entries[0].sha256 = '9'.repeat(64);
  const corruptRuntime = await adapter.createPlan({ request, inspection: inspection(), source: conflictSource });
  assert.equal(
    corruptRuntime.plan.ownership.actions.find(action => action.pathKey === 'server.jar').action,
    'replace'
  );
  assert.equal(corruptRuntime.plan.disk.candidateBytes, '5');
});

test('GitHub repair identity includes reviewed assets, artifact digest, pattern, and accepted mapping', () => {
  const mapping = {
    type: 'provider-source-mapping', version: 1, modrinthProjectId: 'project-one',
    githubRepositoryId: '101', githubOwner: 'Owner', githubRepo: 'Pack'
  };
  const pattern = { type: 'github-asset-pattern', version: 1, marker: 'reviewed-one' };
  const installed = {
    provider: 'github', repositoryId: '101', releaseId: '201', githubOwner: 'Owner', githubRepo: 'Pack',
    selectedAssetIds: ['301'], artifactSetDigest: '8'.repeat(64), assetPattern: pattern, acceptedMapping: mapping
  };
  assert.equal(sameRepairSource(installed, structuredClone(installed), '8'.repeat(64)), true);
  assert.equal(sameRepairSource(
    { ...installed, selectedAssetIds: ['301', '302'] },
    { ...installed, selectedAssetIds: ['302', '301'] },
    '8'.repeat(64)
  ), true);
  for (const reviewed of [
    { ...installed, selectedAssetIds: ['302'] },
    { ...installed, assetPattern: { ...pattern, marker: 'reviewed-two' } },
    { ...installed, acceptedMapping: { ...mapping, modrinthProjectId: 'project-two' } }
  ]) {
    assert.equal(sameRepairSource(installed, reviewed, '8'.repeat(64)), false);
  }
  assert.equal(sameRepairSource(installed, installed, '9'.repeat(64)), false);
});

test('rollback snapshot remains available after uninstall has made modpack state inactive', async t => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'minecraft-core-inactive-rollback-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const serverPath = path.join(root, 'Inactive Server');
  fs.mkdirSync(path.join(serverPath, 'world'), { recursive: true });
  fs.writeFileSync(path.join(serverPath, 'world', 'level.dat'), 'world-after-uninstall');
  const targetRuntime = {
    minecraftVersion: '1.20.1', loaderFamily: 'forge', loaderVersion: '47.3.0',
    javaMajor: 17, os: 'win32', architecture: 'x64'
  };
  const inactive = {
    state: {
      modpackManaged: false, lifecycleMode: 'uninstalled', runtime: null,
      contentRevision: 9,
      source: {
        provider: 'modrinth', projectId: 'project-one', versionId: 'version-one',
        version: '1.0.0', title: 'Project One'
      }
    },
    manifest: null
  };
  const snapshotServer = createProductionServerSnapshot({
    fsApi: fs,
    reparseInspector,
    stateRepository: {
      read() { return inactive; },
      listHistory() {
        return {
          items: [{
            restorePointId: 'restore-before-uninstall', restorePointSha256: 'a'.repeat(64),
            restorePointTotalBytes: '123456789', sourceRevision: 8, sourceRuntime: targetRuntime
          }]
        };
      }
    }
  });

  const snapshot = await snapshotServer({
    currentState: inactive,
    operationKind: 'rollback-restore-point',
    runtime: null,
    serverKind: 'existing',
    serverPath
  });
  assert.equal(snapshot.liveSnapshot.entries.some(entry => entry.path === 'world/level.dat'), true);
  assert.deepEqual(snapshot.restorePoints, [{
    id: 'restore-before-uninstall', sha256: 'a'.repeat(64), sourceRevision: 8,
    runtime: targetRuntime, worldIncluded: true, totalBytes: '123456789'
  }]);
  assert.equal(snapshot.sourceRuntime, null);

  const adapter = new ProductionPlanningAdapter({
    instanceResolver: { async resolveInstance(instanceId) { return { instanceId, serverPath, priorRunning: false }; } },
    stateRepository: { read() { return inactive; } },
    reparseInspector,
    validateServerPorts: availablePortValidation,
    preparePlanInputs: async () => { throw new Error('rollback must not prepare source input'); },
    snapshotServer,
    availableBytes: async () => '999999999999',
    workspaceRegistry: {
      createPlanningSession() { return 'planning-inactive-rollback'; },
      createStagingOutput() { return 'output-inactive-rollback'; },
      releaseOwner() { return 1; }
    },
    resolveRestorePoint: async () => ({
      id: 'restore-before-uninstall', sha256: 'a'.repeat(64), name: 'restore-point-before-uninstall.zip',
      size: 100, totalBytes: '123456789', scopeSha256: 'b'.repeat(64), sourceRevision: 8, sourceRuntime: targetRuntime,
      operationId: 'operation-before-uninstall', createdAt: '2026-08-01T00:00:00.000Z', serverPath,
      archivePath: path.join(serverPath, 'backups', 'restore-point-before-uninstall.zip'),
      metadataPath: path.join(serverPath, 'backups', 'restore-point-before-uninstall.json')
    })
  });
  const planned = await adapter.createManagementPlan({
    request: {
      instanceId: 'server-inactive', operationKind: 'rollback-restore-point',
      selectionRef: 'restore-before-uninstall'
    },
    currentState: inactive,
    instance: { instanceId: 'server-inactive', serverPath }
  });
  assert.equal(planned.plan.runtime.minecraftVersion, '1.20.1');
  assert.equal(planned.plan.operation.expectedContentRevision, 9);
  assert.equal(adapter.getExecutionRecord(planned.plan).selectedRestorePoint.id, 'restore-before-uninstall');

  await assert.rejects(snapshotServer({
    currentState: inactive,
    operationKind: 'uninstall',
    runtime: null,
    serverKind: 'existing',
    serverPath
  }), error => error?.code === 'PLAN_STALE');
});
