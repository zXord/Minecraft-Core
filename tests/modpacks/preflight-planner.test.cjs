const assert = require('node:assert/strict');
const test = require('node:test');

const { createArtifactSetPlan, finalizeVerifiedArtifactSet } = require('../../electron/services/modpacks/contracts.cjs');
const { buildPreflightPlan, assertPlanStillValid } = require('../../electron/services/modpacks/planning/preflight-planner.cjs');
const { planOwnership } = require('../../electron/services/modpacks/planning/ownership-planner.cjs');
const { computePreflightPlanFingerprint } = require('../../electron/services/modpacks/planning/plan-fingerprint.cjs');

const sha256 = character => character.repeat(64);
const sha512 = character => character.repeat(128);

function artifact({ providerDigest = true, projectId = '123', releaseId = '456' } = {}) {
  const plan = createArtifactSetPlan({
    provider: 'github',
    project: { id: projectId, slug: 'owner-pack', title: 'Pack' },
    release: { id: releaseId, version: 'v2', channel: 'release', publishedAt: '2026-08-01T00:00:00.000Z' },
    artifactSet: {
      kind: 'single', primaryPartId: '789', groupingScheme: 'single',
      parts: [{
        partId: '789', providerAssetId: '789', fileName: 'server-pack.zip', size: '1024',
        updatedAt: '2026-08-01T00:00:00.000Z',
        ...(providerDigest ? { providerDigest: { algorithm: 'sha256', value: sha256('a') } } : {})
      }],
      providerImmutable: false,
      attestationStatus: 'unavailable'
    }
  });
  return finalizeVerifiedArtifactSet(plan, [{ partId: '789', measuredSize: '1024', sha256: sha256('b'), sha512: sha512('c') }]);
}

function localArtifact() {
  const plan = createArtifactSetPlan({
    provider: 'local',
    artifactSet: {
      kind: 'single', primaryPartId: 'local-part', groupingScheme: 'single',
      parts: [{ partId: 'local-part', fileName: 'local-pack.zip', size: '1024' }],
      providerImmutable: false,
      attestationStatus: 'unavailable'
    }
  });
  return finalizeVerifiedArtifactSet(plan, [{
    partId: 'local-part', measuredSize: '1024', sha256: sha256('b'), sha512: sha512('c')
  }]);
}

function runtime(version = '1.21.1') {
  return { minecraftVersion: version, loaderFamily: 'fabric', loaderVersion: '0.16.14', javaMajor: 21, os: 'win32', architecture: 'x64' };
}

function ownership() {
  return planOwnership({
    oldManifest: null,
    liveSnapshot: { kind: 'existing', worldDirectories: ['world'], entries: [] },
    incomingManifest: { schemaVersion: 1, installationId: 'incoming', entries: [] },
    conflictChoices: {}
  });
}

function input(overrides = {}) {
  return {
    operation: { kind: 'upgrade', serverKind: 'existing', instanceId: 'instance-1', expectedContentRevision: 7, downgrade: false },
    source: {
      provider: 'github', repositoryId: '123', releaseId: '456',
      githubOwner: 'Fixture-Owner', githubRepo: 'fixture.pack', version: 'v2'
    },
    artifactSet: artifact(),
    runtime: runtime(),
    inspection: { kind: 'prepared-server-pack', selectedRoot: null, expandedBytes: '4096', entryCount: 4, fingerprint: sha256('d') },
    serverSnapshot: {
      contentRevision: 7,
      availableBytes: String(4n * 1024n * 1024n * 1024n),
      candidateBytes: '8192', restorePointBytes: '16384', rollbackBytes: '32768', journalBytes: '4096',
      writeable: true,
      pathPreconditions: [
        { path: 'mods/a.jar', pathKey: 'mods/a.jar', exists: true, type: 'file', size: '4', sha256: sha256('e'), dev: '1', ino: '2', birthtime: '3' },
        { path: 'mods/missing.jar', pathKey: 'mods/missing.jar', exists: false, type: null, size: null, sha256: null, dev: null, ino: null, birthtime: null }
      ],
      sourceRuntime: runtime('1.20.1')
    },
    ownershipPlan: ownership(),
    restorePoints: [{ id: 'restore-1', sha256: sha256('f'), sourceRevision: 7, runtime: runtime('1.20.1'), worldIncluded: true }],
    selections: { optionalFileIds: ['optional-a'], conflictChoices: {}, acknowledgeMissingProviderDigest: false, acknowledgeDowngradeWorldRisk: false },
    ...overrides
  };
}

function currentSnapshot(plan) {
  return {
    contentRevision: plan.preconditions.contentRevision,
    pathPreconditions: plan.preconditions.paths,
    sourceIdentity: plan.preconditions.sourceIdentity,
    artifactSetDigest: plan.preconditions.artifactSetDigest,
    artifactPartsFingerprint: plan.preconditions.artifactPartsFingerprint,
    runtime: plan.runtime,
    inspectionFingerprint: plan.preconditions.inspectionFingerprint,
    ownershipFingerprint: plan.preconditions.ownershipFingerprint,
    selectionsFingerprint: plan.preconditions.selectionsFingerprint,
    restorePointsFingerprint: plan.preconditions.restorePointsFingerprint,
    assetPatternFingerprint: plan.preconditions.assetPatternFingerprint,
    acceptedMappingFingerprint: plan.preconditions.acceptedMappingFingerprint,
    operationFingerprint: plan.preconditions.operationFingerprint,
    availableBytes: plan.disk.availableBytes
  };
}

test('preflight is deterministic, URL/path-free, and uses exact BigInt footprint plus reserve', () => {
  const first = buildPreflightPlan(input());
  const second = buildPreflightPlan(input());
  assert.deepEqual(first, second);
  assert.equal(first.fingerprint, computePreflightPlanFingerprint(first));
  assert.equal(first.disk.reserveBytes, String(2n * 1024n * 1024n * 1024n));
  assert.equal(first.disk.requiredBytes,
    String(1024n + 4096n + 8192n + 16384n + 32768n + 4096n + 2n * 1024n * 1024n * 1024n));
  const serialized = JSON.stringify(first);
  assert.doesNotMatch(serialized, /https?:|cachePath|archivePath|serverPath/i);
  assert.equal(Object.isFrozen(first), true);
});

test('guided root and runtime choices are fingerprinted while safe files-only plans require no runtime', () => {
  const guidedInput = input();
  guidedInput.selections.selectedRoot = 'Reviewed server root';
  guidedInput.selections.runtimeChoice = {
    minecraftVersion: '1.21.1', loaderFamily: 'fabric', loaderVersion: '0.16.14'
  };
  const guided = buildPreflightPlan(guidedInput);
  assert.equal(guided.selections.selectedRoot, 'Reviewed server root');
  assert.deepEqual(guided.selections.runtimeChoice, guidedInput.selections.runtimeChoice);

  const filesOnlyInput = input({
    operation: { kind: 'files-only', serverKind: 'new', instanceId: 'instance-files', expectedContentRevision: 0, downgrade: false },
    runtime: null,
    inspection: {
      kind: 'files-only', selectedRoot: null, expandedBytes: '4096', entryCount: 4,
      fingerprint: sha256('d'), filesOnlySafe: true
    },
    serverSnapshot: {
      contentRevision: 0,
      availableBytes: String(4n * 1024n * 1024n * 1024n),
      candidateBytes: '8192', restorePointBytes: '0', rollbackBytes: '0', journalBytes: '4096',
      writeable: true, pathPreconditions: [], sourceRuntime: null
    },
    restorePoints: [],
    selections: {
      optionalFileIds: [], conflictChoices: {}, acknowledgeMissingProviderDigest: false,
      acknowledgeDowngradeWorldRisk: false, selectedRoot: null, runtimeChoice: null
    }
  });
  const filesOnly = buildPreflightPlan(filesOnlyInput);
  assert.equal(filesOnly.runtime, null);
  assert.equal(filesOnly.requirements.filesOnlySafetyConfirmed, true);
  assert.equal(assertPlanStillValid(filesOnly, currentSnapshot(filesOnly)), filesOnly);
});

test('preflight rejects insufficient disk, unwritable targets, and missing exact provider acknowledgement', () => {
  const tooSmall = input();
  tooSmall.serverSnapshot.availableBytes = '1';
  assert.throws(() => buildPreflightPlan(tooSmall), error => error.code === 'INSUFFICIENT_DISK');
  const unwritable = input();
  unwritable.serverSnapshot.writeable = false;
  assert.throws(() => buildPreflightPlan(unwritable), error => error.code === 'INVALID_REQUEST');
  const missingDigest = input({ artifactSet: artifact({ providerDigest: false }) });
  assert.throws(() => buildPreflightPlan(missingDigest), error => error.code === 'MISSING_PROVIDER_DIGEST');
  missingDigest.selections.acknowledgeMissingProviderDigest = true;
  assert.equal(buildPreflightPlan(missingDigest).requirements.missingProviderDigestAcknowledged, true);
  const unnecessaryAcknowledgement = input();
  unnecessaryAcknowledgement.selections.acknowledgeMissingProviderDigest = true;
  assert.throws(() => buildPreflightPlan(unnecessaryAcknowledgement), error => error.code === 'INVALID_REQUEST');
});

test('preflight accepts only app-issued ownership and validates persisted asset-pattern evidence', () => {
  const forgedOwnership = input({ ownershipPlan: structuredClone(ownership()) });
  assert.throws(() => buildPreflightPlan(forgedOwnership), error => error.code === 'INVALID_REQUEST');
  const malformedPattern = input();
  malformedPattern.source.assetPattern = {
    type: 'github-asset-pattern', version: 1, filenameMatchers: [{ kind: 'literal', value: 'CON.zip' }]
  };
  assert.throws(() => buildPreflightPlan(malformedPattern), error => error.code === 'INVALID_REQUEST');
});

test('preflight binds mapping evidence to the selected permanent provider ID', () => {
  const mismatchedMapping = input();
  mismatchedMapping.source.acceptedMapping = {
    type: 'provider-source-mapping',
    version: 1,
    modrinthProjectId: 'pack-project',
    githubRepositoryId: '999',
    githubOwner: 'Owner',
    githubRepo: 'Pack'
  };
  assert.throws(() => buildPreflightPlan(mismatchedMapping), error => error.code === 'INVALID_REQUEST');
});

test('preflight requires numeric permanent GitHub repository and release IDs', () => {
  const nonNumericIdentity = input({
    source: { provider: 'github', repositoryId: 'repository-name', releaseId: 'release-tag', version: 'v2' },
    artifactSet: artifact({ projectId: 'repository-name', releaseId: 'release-tag' })
  });
  assert.throws(() => buildPreflightPlan(nonNumericIdentity), error => error.code === 'INVALID_REQUEST');
});

test('preflight binds the trusted GitHub owner and repository needed after restart', () => {
  const plan = buildPreflightPlan(input());
  assert.deepEqual(plan.source, {
    provider: 'github', repositoryId: '123', releaseId: '456',
    githubOwner: 'Fixture-Owner', githubRepo: 'fixture.pack', version: 'v2'
  });
  for (const field of ['githubOwner', 'githubRepo']) {
    const missing = input();
    delete missing.source[field];
    assert.throws(() => buildPreflightPlan(missing), error => error.code === 'INVALID_REQUEST');
  }
  const invalidName = input();
  invalidName.source.githubRepo = '../escape';
  assert.throws(() => buildPreflightPlan(invalidName), error => error.code === 'INVALID_REQUEST');
});

test('local source identity is bound to the verified artifact-set digest', () => {
  const verified = localArtifact();
  const mismatched = input({
    source: {
      provider: 'local', importId: 'import-1', artifactSha256: sha256('0'), version: 'local-1'
    },
    artifactSet: verified
  });
  assert.notEqual(mismatched.source.artifactSha256, verified.artifactSet.setDigest);
  assert.throws(() => buildPreflightPlan(mismatched), error => error.code === 'INVALID_REQUEST');
  mismatched.source.artifactSha256 = verified.artifactSet.setDigest;
  assert.equal(buildPreflightPlan(mismatched).source.artifactSha256, verified.artifactSet.setDigest);
});

test('preflight conflict decisions reject uncontrolled metadata', () => {
  const leakedDecision = input();
  leakedDecision.selections.conflictChoices = {
    paths: {
      'config/example.toml': {
        choice: 'keep-mine',
        sourceUrl: 'https://example.invalid/private'
      }
    }
  };
  assert.throws(() => buildPreflightPlan(leakedDecision), error => error.code === 'INVALID_REQUEST');
});

test('preflight conflict decisions must exactly match the app-issued ownership plan', () => {
  const selectedOwnership = planOwnership({
    oldManifest: null,
    liveSnapshot: {
      kind: 'existing',
      entries: [{
        path: 'config/collision.toml', pathKey: 'config/collision.toml', type: 'file',
        sha256: sha256('1'), size: '1', origin: 'user'
      }]
    },
    incomingManifest: {
      schemaVersion: 1,
      installationId: 'incoming-selected',
      entries: [{
        path: 'config/collision.toml', pathKey: 'config/collision.toml', origin: 'pack',
        managementPolicy: 'replaceable-managed', role: 'configuration', installedHash: sha256('2'),
        size: '1', priorBaseline: null
      }]
    },
    conflictChoices: { paths: { 'config/collision.toml': { choice: 'use-pack' } } }
  });
  const missingDecision = input({ ownershipPlan: selectedOwnership });
  assert.throws(() => buildPreflightPlan(missingDecision), error => error.code === 'INVALID_REQUEST');

  const matchingDecision = input({ ownershipPlan: selectedOwnership });
  matchingDecision.selections.conflictChoices = {
    paths: { 'CONFIG\\COLLISION.TOML': { choice: 'use-pack' } }
  };
  assert.equal(buildPreflightPlan(matchingDecision).ownership.actions[0].action, 'replace');

  const changedDecision = input({ ownershipPlan: selectedOwnership });
  changedDecision.selections.conflictChoices = {
    paths: { 'config/collision.toml': { choice: 'keep-mine' } }
  };
  assert.throws(() => buildPreflightPlan(changedDecision), error => error.code === 'INVALID_REQUEST');
});

test('downgrades require explicit world acknowledgement and a compatible verified restore point', () => {
  const downgrade = input();
  downgrade.operation.downgrade = true;
  downgrade.selections.acknowledgeDowngradeWorldRisk = true;
  const plan = buildPreflightPlan(downgrade);
  assert.equal(plan.requirements.downgradeWorldRiskAcknowledged, true);
  const unacknowledged = input();
  unacknowledged.operation.downgrade = true;
  assert.throws(() => buildPreflightPlan(unacknowledged), error => error.code === 'INVALID_REQUEST');
  const withoutRestore = input();
  withoutRestore.operation.downgrade = true;
  withoutRestore.selections.acknowledgeDowngradeWorldRisk = true;
  withoutRestore.restorePoints = [];
  assert.throws(() => buildPreflightPlan(withoutRestore), error => error.code === 'INVALID_REQUEST');
});

test('existing-server file mutations require a verified restore point before commit', () => {
  const upgrade = buildPreflightPlan(input());
  assert.equal(upgrade.requirements.verifiedRestorePointRequired, true);

  const detached = input();
  detached.operation.kind = 'detach';
  assert.equal(buildPreflightPlan(detached).requirements.verifiedRestorePointRequired, false);

  const fresh = input();
  fresh.operation = {
    kind: 'install', serverKind: 'new', instanceId: 'instance-new', expectedContentRevision: 0, downgrade: false
  };
  fresh.serverSnapshot.contentRevision = 0;
  assert.equal(buildPreflightPlan(fresh).requirements.verifiedRestorePointRequired, false);
});

test('every execution precondition mutation makes the reviewed plan stale', () => {
  const plan = buildPreflightPlan(input());
  const current = currentSnapshot(plan);
  assert.equal(assertPlanStillValid(plan, current), plan);
  const mutations = [
    value => { value.contentRevision += 1; },
    value => { value.pathPreconditions[0] = { ...value.pathPreconditions[0], sha256: sha256('0') }; },
    value => { value.pathPreconditions[0] = { ...value.pathPreconditions[0], size: '5' }; },
    value => { value.pathPreconditions[0] = { ...value.pathPreconditions[0], dev: '9' }; },
    value => { value.pathPreconditions[0] = { ...value.pathPreconditions[0], ino: '9' }; },
    value => { value.pathPreconditions[0] = { ...value.pathPreconditions[0], birthtime: '9' }; },
    value => { value.pathPreconditions[1] = { ...value.pathPreconditions[1], exists: true, type: 'directory', size: '0', dev: '1', ino: '2', birthtime: '3' }; },
    value => { value.sourceIdentity = { ...value.sourceIdentity, releaseId: '999' }; },
    value => { value.artifactSetDigest = sha256('0'); },
    value => { value.artifactPartsFingerprint = sha256('0'); },
    value => { value.runtime = runtime('1.21.2'); },
    value => { value.inspectionFingerprint = sha256('0'); },
    value => { value.ownershipFingerprint = sha256('0'); },
    value => { value.selectionsFingerprint = sha256('0'); },
    value => { value.restorePointsFingerprint = sha256('0'); },
    value => { value.assetPatternFingerprint = sha256('0'); },
    value => { value.acceptedMappingFingerprint = sha256('0'); },
    value => { value.operationFingerprint = sha256('0'); },
    value => { value.availableBytes = '1'; }
  ];
  for (const mutate of mutations) {
    const changed = structuredClone(current);
    mutate(changed);
    assert.throws(() => assertPlanStillValid(plan, changed), error => error.code === 'PLAN_STALE');
  }
});

test('a cloned or self-refingerprinted plan cannot claim app-issued trust', () => {
  const plan = buildPreflightPlan(input());
  const current = currentSnapshot(plan);
  const cloned = structuredClone(plan);
  cloned.fingerprint = computePreflightPlanFingerprint(cloned);
  assert.throws(() => assertPlanStillValid(cloned, current), error => error.code === 'PLAN_STALE');

  const forged = structuredClone(plan);
  forged.operation.instanceId = 'forged-instance';
  forged.fingerprint = computePreflightPlanFingerprint(forged);
  assert.throws(() => assertPlanStillValid(forged, current), error => error.code === 'PLAN_STALE');
});

test('fingerprints cover decisions, restore points, ownership, inspection, and reject accessor input', () => {
  const baseline = buildPreflightPlan(input());
  for (const mutate of [
    value => { value.selections.optionalFileIds.push('other'); },
    value => { value.restorePoints[0].sha256 = sha256('0'); },
    value => { value.inspection.fingerprint = sha256('0'); },
    value => { value.operation.kind = 'switch'; }
  ]) {
    const changed = input();
    mutate(changed);
    assert.notEqual(buildPreflightPlan(changed).fingerprint, baseline.fingerprint);
  }
  let calls = 0;
  const unsafe = input();
  Object.defineProperty(unsafe.source, 'provider', { enumerable: true, get() { calls += 1; return 'github'; } });
  assert.throws(() => buildPreflightPlan(unsafe), error => error.code === 'INVALID_REQUEST');
  assert.equal(calls, 0);
});
