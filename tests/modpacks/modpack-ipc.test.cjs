const assert = require('node:assert/strict');
const test = require('node:test');

const { createModpackHandlers, MODPACK_INVOKE_CHANNELS } = require('../../electron/ipc/modpack-handlers.cjs');
const { ModpackError } = require('../../electron/services/modpacks/errors.cjs');
const { validateModpackIpcEvent } = require('../../electron/services/modpacks/ipc-schemas.cjs');
const FINGERPRINT = 'a'.repeat(64);

function createFixture() {
  const calls = [];
  const value = name => async request => {
    calls.push([name, request]);
    return request === undefined ? { kind: name } : { kind: name, request };
  };
  const dependencies = {
    providers: {
      modrinth: {
        searchProjects: value('searchProjects'),
        getProject: value('getProject'),
        listVersions: value('listVersions')
      },
      github: {
        async listReleases(request) {
          calls.push(['listReleases', request]);
          return { repositoryId: '1234', releases: [], pagination: { perPage: 100, nextCursor: null }, notModified: false };
        },
        loadUploadedAssets: value('loadUploadedAssets')
      }
    },
    localArtifactSource: { selectWithNativeDialog: value('selectWithNativeDialog') },
    destinationReservationService: { reserveWithNativeDialog: value('reserveWithNativeDialog') },
    lifecycleService: {
      inspectSource: value('inspectSource'),
      createPlan: value('createPlan'),
      createManagementPlan: value('createManagementPlan'),
      startOperation: value('startOperation'),
      cancelJob: value('cancelJob'),
      getJob: value('getJob'),
      getState: value('getState'),
      listHistory: value('listHistory'),
      listRecovery: value('listRecovery'),
      recover: value('recover'),
      verify: value('verify')
    },
    notificationStore: { list: value('listNotifications'), acknowledge: value('acknowledge') },
    releaseMonitor: { checkAll: value('checkAll'), checkOne: value('checkOne') },
    releaseTrackingStore: { upsert: value('upsertTracking'), list: value('listTracking') },
    recoveryService: { listRecovery: value('listRecovery'), recover: value('recover') },
    outcomeActionService: { performSafeAction: value('performSafeAction') }
  };
  return { calls, dependencies, handlers: createModpackHandlers(dependencies) };
}

test('renderer paths are rejected before any safe action runs', async () => {
  const { calls, handlers } = createFixture();
  const result = await handlers['modpacks:perform-safe-action']({}, {
    actionId: 'remove-retained-download',
    path: 'C:\\x'
  });
  assert.equal(result.ok, false);
  assert.equal(result.error.code, 'INVALID_REQUEST');
  assert.equal(calls.length, 0);
});

test('the handler factory exposes exactly the approved lifecycle invoke channels', () => {
  const { handlers } = createFixture();
  assert.deepEqual(Object.keys(handlers).sort(), [...MODPACK_INVOKE_CHANNELS].sort());
});

const TRACKING = {
  trackingId: 'tracking-one',
  serverId: 'server-one',
  provider: 'github',
  projectId: null,
  repositoryId: '1234',
  githubOwner: 'owner',
  githubRepo: 'pack',
  includePrereleases: false,
  acceptedMapping: null,
  assetPattern: null,
  etag: null,
  lastSuccessfulCheck: null,
  lastFailure: null,
  nextDueAt: '2026-08-03T00:00:00.000Z',
  lastSnapshot: null
};

const VALID_REQUESTS = {
  'modpacks:search-catalog': { query: 'technology', limit: 20 },
  'modpacks:get-project': { projectId: 'project-one' },
  'modpacks:list-versions': { projectId: 'project-one', channels: ['release'] },
  'modpacks:list-github-releases': { repositoryUrl: 'https://github.com/owner/pack', includePrereleases: false },
  'modpacks:list-github-assets': { repositoryId: '1234', releaseId: '5678' },
  'modpacks:select-local-archive': { allowMultipart: true },
  'modpacks:reserve-server-destination': {},
  'modpacks:inspect': {
    provider: 'github', repositoryId: '1234', releaseId: '5678', assetIds: ['9012'],
    rememberAssetPattern: true, linkedModrinthProjectId: 'project-one'
  },
  'modpacks:preflight': {
    inspectionId: 'inspection-one',
    instanceId: 'server-one',
    operationKind: 'install-existing',
    selections: {
      optionalFileIds: [], conflictChoices: {}, acknowledgeMissingProviderDigest: false
    }
  },
  'modpacks:preflight-management': {
    serverId: 'server-one',
    operationKind: 'rollback-restore-point',
    selectionRef: 'restore-one'
  },
  'modpacks:start-operation': { planId: 'plan-one', planFingerprint: FINGERPRINT, choices: {} },
  'modpacks:cancel-job': { jobId: 'job-one' },
  'modpacks:get-job': { jobId: 'job-one' },
  'modpacks:get-state': { serverId: 'server-one' },
  'modpacks:list-history': { serverId: 'server-one', limit: 25 },
  'modpacks:list-recovery': {},
  'modpacks:recover': { recoveryId: 'recovery-one', actionId: 'retry-cleanup' },
  'modpacks:list-notifications': { unreadOnly: true, limit: 100 },
  'modpacks:ack-notification': { notificationId: 'notice-one' },
  'modpacks:check-updates': { trackingId: 'tracking-one', force: true },
  'modpacks:update-tracking': TRACKING,
  'modpacks:verify': { serverId: 'server-one' },
  'modpacks:perform-safe-action': { actionId: 'retry', opaqueRef: 'job-one' }
};

test('every approved invoke validates a closed request and returns a validated success envelope', async () => {
  const fixture = createFixture();
  for (const channel of MODPACK_INVOKE_CHANNELS) {
    const before = fixture.calls.length;
    const result = await fixture.handlers[channel]({}, structuredClone(VALID_REQUESTS[channel]));
    assert.equal(result.ok, true, `${channel}: ${JSON.stringify(result)}`);
    assert.equal(Object.isFrozen(result), true, channel);
    assert.equal(fixture.calls.length, before + 1, channel);
  }
});

test('unknown fields are rejected on every invoke before its service is called', async () => {
  const fixture = createFixture();
  for (const channel of MODPACK_INVOKE_CHANNELS) {
    const request = { ...structuredClone(VALID_REQUESTS[channel]), unexpected: true };
    const before = fixture.calls.length;
    const result = await fixture.handlers[channel]({}, request);
    assert.equal(result.ok, false, channel);
    assert.equal(result.error.code, 'INVALID_REQUEST', channel);
    assert.equal(fixture.calls.length, before, channel);
  }
});

test('accessors functions cycles and authority-bearing nested fields fail closed', async () => {
  const fixture = createFixture();
  let getterCalls = 0;
  const accessor = { jobId: 'job-one' };
  Object.defineProperty(accessor, 'extra', { enumerable: true, get() { getterCalls += 1; return true; } });
  const cyclic = { actionId: 'retry' };
  cyclic.opaqueRef = cyclic;
  const cases = [
    ['modpacks:get-job', accessor],
    ['modpacks:perform-safe-action', { actionId: 'retry', opaqueRef: () => true }],
    ['modpacks:perform-safe-action', cyclic],
    ['modpacks:preflight', {
      ...VALID_REQUESTS['modpacks:preflight'],
      selections: { ...VALID_REQUESTS['modpacks:preflight'].selections, providerInternal: { raw: true } }
    }]
  ];
  for (const [channel, request] of cases) {
    const result = await fixture.handlers[channel]({}, request);
    assert.equal(result.ok, false, channel);
    assert.equal(result.error.code, 'INVALID_REQUEST', channel);
  }
  assert.equal(getterCalls, 0);
  assert.equal(fixture.calls.length, 0);
});

test('only the GitHub source channel accepts its constrained public repository URL', async () => {
  const fixture = createFixture();
  const accepted = await fixture.handlers['modpacks:list-github-releases']({}, {
    repositoryUrl: 'https://github.com/owner/pack/releases/tag/v1.2.3',
    includePrereleases: true
  });
  assert.equal(accepted.ok, true);
  const rejected = await fixture.handlers['modpacks:perform-safe-action']({}, {
    actionId: 'retry', opaqueRef: 'https://github.com/owner/pack'
  });
  assert.equal(rejected.ok, false);
  assert.equal(rejected.error.code, 'INVALID_REQUEST');
});

test('GitHub inspection preferences are closed to GitHub source requests', async () => {
  const fixture = createFixture();
  for (const request of [
    { provider: 'local', selectionId: 'selection-one', rememberAssetPattern: true },
    { provider: 'modrinth', projectId: 'project-one', versionId: 'version-one', linkedModrinthProjectId: 'project-one' }
  ]) {
    const result = await fixture.handlers['modpacks:inspect']({}, request);
    assert.equal(result.ok, false);
    assert.equal(result.error.code, 'INVALID_REQUEST');
  }
  assert.equal(fixture.calls.length, 0);
});

test('managed GitHub asset review receives only the single provisional selection suggested by its saved pattern', async () => {
  const fixture = createFixture();
  const { compileAssetPattern } = require('../../electron/services/modpacks/providers/github-asset-pattern.cjs');
  const pattern = compileAssetPattern({
    filenameMatcher: 'server-pack-*.zip', reviewedRole: 'server-pack',
    archiveRootFingerprint: 'f'.repeat(64),
    runtimeEvidence: {
      minecraftVersion: '1.21.1', loaderFamily: 'fabric', loaderVersion: '0.16.14',
      javaMajor: 21, os: 'win32', architecture: 'x64'
    },
    multipartStructure: { kind: 'single', groupingScheme: 'single', partCount: 1, primaryIndex: 0 },
    userOverrides: { selectedRoot: null, runtimeChoice: null }
  });
  fixture.dependencies.releaseTrackingStore.list = async () => [{
    ...TRACKING, serverId: 'server-one', repositoryId: '1234', assetPattern: pattern
  }];
  fixture.dependencies.providers.github.loadUploadedAssets = async () => ({
    repositoryId: '1234', releaseId: '5678', status: 'ready', assets: [],
    choices: [{
      kind: 'single', groupingScheme: 'single', primaryPartId: '9012', complete: true,
      parts: [{ providerAssetId: '9012', fileName: 'server-pack-v2.zip' }]
    }]
  });
  const handlers = createModpackHandlers(fixture.dependencies);

  const result = await handlers['modpacks:list-github-assets']({}, {
    repositoryId: '1234', releaseId: '5678', serverId: 'server-one'
  });
  assert.equal(result.ok, true);
  assert.deepEqual(result.value.suggestedAssetIds, ['9012']);
  assert.doesNotMatch(JSON.stringify(result.value), /assetPattern|archiveRootFingerprint/);
});

test('version browsing strips acquisition URLs while catalog display candidates stay public', async () => {
  const first = createFixture();
  first.dependencies.providers.modrinth.listVersions = async () => [{
    versionId: 'version-one',
    files: [{ fileName: 'pack.mrpack', size: '12', downloadUrlCandidate: 'https://cdn.modrinth.com/data/private' }]
  }];
  const versions = await first.handlers['modpacks:list-versions']({}, { projectId: 'project-one' });
  assert.equal(versions.ok, true);
  assert.doesNotMatch(JSON.stringify(versions), /https?:|downloadUrl/i);

  const second = createFixture();
  second.dependencies.providers.modrinth.getProject = async () => ({
    projectId: 'project-one', iconUrlCandidate: 'https://cdn.modrinth.com/data/icon.png'
  });
  const project = await second.handlers['modpacks:get-project']({}, { projectId: 'project-one' });
  assert.equal(project.ok, true);
  assert.match(project.value.iconUrlCandidate, /^https:/);
});

test('public ModpackError codes survive while native errors and unsafe service output are redacted', async () => {
  const first = createFixture();
  first.dependencies.lifecycleService.getJob = async () => {
    throw new ModpackError('PLAN_STALE', 'The reviewed modpack plan is stale');
  };
  const stale = await first.handlers['modpacks:get-job']({}, { jobId: 'job-one' });
  assert.equal(stale.error.code, 'PLAN_STALE');

  const second = createFixture();
  second.dependencies.lifecycleService.getJob = async () => {
    const error = new Error('private C:\\servers\\secret token=hunter2');
    error.stack = 'native private stack';
    throw error;
  };
  const failed = await second.handlers['modpacks:get-job']({}, { jobId: 'job-one' });
  assert.equal(failed.error.code, 'COMMIT_FAILED');
  assert.doesNotMatch(JSON.stringify(failed), /servers|hunter2|stack/i);

  const third = createFixture();
  third.dependencies.lifecycleService.getJob = async () => ({ jobId: 'job-one', serverPath: 'C:\\servers\\private' });
  const unsafeOutput = await third.handlers['modpacks:get-job']({}, { jobId: 'job-one' });
  assert.equal(unsafeOutput.error.code, 'INVALID_REQUEST');
  assert.doesNotMatch(JSON.stringify(unsafeOutput), /servers|private/i);
});

test('all four lifecycle event payloads are JSON-only and authority-free', () => {
  for (const channel of ['modpacks:job-progress', 'modpacks:job-log', 'modpacks:state-changed', 'modpacks:notification']) {
    const event = validateModpackIpcEvent(channel, { jobId: 'job-one', message: 'Safe progress', percent: 50 });
    assert.equal(Object.isFrozen(event), true);
    assert.throws(
      () => validateModpackIpcEvent(channel, { jobId: 'job-one', serverPath: 'C:\\private' }),
      error => error.code === 'INVALID_REQUEST'
    );
  }
});
