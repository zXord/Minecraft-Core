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
    destinationReservationService: {
      reserveWithNativeDialog: value('reserveWithNativeDialog'),
      release: value('releaseServerDestination')
    },
    lifecycleService: {
      releaseServerDestination: value('releaseServerDestination'),
      inspectSource: value('inspectSource'),
      cancelInspection: value('cancelInspection'),
      createPlan: value('createPlan'),
      createManagementPlan: value('createManagementPlan'),
      startOperation: value('startOperation'),
      cancelJob: value('cancelJob'),
      getJob: value('getJob'),
      async getActiveJobs(serverId) { calls.push(['getActiveJobs', serverId]); return { serverId, items: [] }; },
      getState: value('getState'),
      listHistory: value('listHistory'),
      listRollbackOptions: value('listRollbackOptions'),
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
  'modpacks:release-server-destination': { instanceId: 'server-reserved-one' },
  'modpacks:inspect': {
    provider: 'github', repositoryId: '1234', releaseId: '5678', assetIds: ['9012'],
    rememberAssetPattern: true, linkedModrinthProjectId: 'project-one'
  },
  'modpacks:cancel-inspection': { inspectionId: 'inspection-reviewed-one' },
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
  'modpacks:get-active-jobs': { serverId: 'server-one' },
  'modpacks:get-state': { serverId: 'server-one' },
  'modpacks:list-history': { serverId: 'server-one', limit: 25 },
  'modpacks:list-rollback-options': { serverId: 'server-one' },
  'modpacks:list-recovery': {},
  'modpacks:recover': { recoveryId: 'recovery-one', actionId: 'retry-cleanup' },
  'modpacks:list-notifications': { unreadOnly: true, limit: 100 },
  'modpacks:ack-notification': { notificationId: 'notice-one' },
  'modpacks:check-updates': { trackingId: 'tracking-one', force: true },
  'modpacks:update-tracking': TRACKING,
  'modpacks:verify': { serverId: 'server-one' },
  'modpacks:perform-safe-action': { actionId: 'retry', opaqueRef: 'job-one' }
};

test('active discovery IPC binds the result to the requested server', async () => {
  const f = createFixture();
  assert.deepEqual(await f.handlers['modpacks:get-active-jobs']({}, { serverId: 'server-one' }), { ok: true, value: { serverId: 'server-one', items: [] } });
  assert.deepEqual(f.calls, [['getActiveJobs', 'server-one']]);
  f.dependencies.lifecycleService.getActiveJobs = async () => ({ serverId: 'server-two', items: [] });
  const result = await createModpackHandlers(f.dependencies)['modpacks:get-active-jobs']({}, { serverId: 'server-one' });
  assert.equal(result.ok, false);
});

test('every approved invoke validates a closed request and returns a validated success envelope', async () => {
  const fixture = createFixture();
  for (const channel of MODPACK_INVOKE_CHANNELS) {
    const before = fixture.calls.length;
    const result = await fixture.handlers[channel]({}, structuredClone(VALID_REQUESTS[channel]));
    assert.equal(result.ok, true, `${channel}: ${JSON.stringify(result)}`);
    assert.equal(Object.isFrozen(result), true, channel);
    const expectedCalls = channel === 'modpacks:cancel-inspection' ? before : before + 1;
    assert.equal(fixture.calls.length, expectedCalls, channel);
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

test('Modrinth renderer DTOs retain approved candidates while isolating embedded display links and private fields', async () => {
  const fixture = createFixture();
  fixture.dependencies.providers.modrinth.getProject = async () => ({
    projectId: 'project-one', slug: 'pack-one', title: 'Pack _https://example.invalid/private_',
    summary: 'Read https://example.invalid/summary for details.',
    body: 'Private full text at https://example.invalid/body.',
    iconUrlCandidate: 'https://cdn.modrinth.com/data/icon.png',
    galleryCandidates: [{
      urlCandidate: 'https://cdn.modrinth.com/data/gallery.png', featured: true,
      title: 'Gallery image', description: 'Caption https://example.invalid/caption.'
    }],
    runtimes: { minecraftVersions: ['1.21.1'], loaders: ['fabric'] },
    serverCompatibility: 'required', updatedAt: '2026-08-01T00:00:00.000Z', downloads: 123,
    upstreamLinkCandidates: [{ kind: 'source', urlCandidate: 'https://github.com/example/pack' }],
    internalUrl: 'https://example.invalid/private'
  });
  fixture.dependencies.providers.modrinth.listVersions = async () => [{
    versionId: 'version-one', projectId: 'project-one', name: 'Release One', version: '1.0.0',
    changelog: 'Changelog https://example.invalid/changelog.', channel: 'release',
    minecraftVersions: ['1.21.1'], loaders: ['fabric'], publishedAt: '2026-08-01T00:00:00.000Z', downloads: 456,
    files: [{ fileName: 'pack.mrpack', downloadUrlCandidate: 'https://cdn.modrinth.com/data/private' }]
  }];

  const project = await fixture.handlers['modpacks:get-project']({}, { projectId: 'project-one' });
  assert.equal(project.ok, true);
  assert.equal(project.value.title, 'Pack _[external link]_');
  assert.equal(project.value.summary, 'Read [external link] for details.');
  assert.equal('body' in project.value, false);
  assert.equal('internalUrl' in project.value, false);
  assert.deepEqual(project.value.galleryCandidates, [{
    urlCandidate: 'https://cdn.modrinth.com/data/gallery.png', featured: true, title: 'Gallery image'
  }]);
  assert.deepEqual(project.value.upstreamLinkCandidates, [{ kind: 'source', urlCandidate: 'https://github.com/example/pack' }]);

  const versions = await fixture.handlers['modpacks:list-versions']({}, { projectId: 'project-one' });
  assert.equal(versions.ok, true);
  assert.deepEqual(versions.value, [{
    versionId: 'version-one', projectId: 'project-one', name: 'Release One', version: '1.0.0',
    channel: 'release', minecraftVersions: ['1.21.1'], loaders: ['fabric'],
    publishedAt: '2026-08-01T00:00:00.000Z', downloads: 456
  }]);
});

test('catalog handler projects paginated Modrinth display data without forwarding unknown authority', async () => {
  const fixture = createFixture();
  fixture.dependencies.providers.modrinth.searchProjects = async () => ({
    items: [{
      projectId: 'project-one', slug: 'pack-one', title: 'Pack _https://example.invalid/title_',
      summary: 'Read https://example.invalid/summary.', categories: ['technology'],
      minecraftVersions: ['1.21.1'], loaders: ['fabric'], serverCompatibility: 'required',
      updatedAt: '2026-08-01T00:00:00.000Z', downloads: 123,
      iconUrlCandidate: 'https://cdn.modrinth.com/data/icon.png',
      galleryUrlCandidates: ['https://cdn.modrinth.com/data/gallery.png'],
      privateUrl: 'https://example.invalid/private'
    }],
    pagination: { offset: 20, limit: 20, total: 61 },
    internalUrl: 'https://example.invalid/catalog-private'
  });

  const catalog = await fixture.handlers['modpacks:search-catalog']({}, { query: 'technology', offset: 20, limit: 20 });
  assert.equal(catalog.ok, true);
  assert.deepEqual(catalog.value, {
    items: [{
      projectId: 'project-one', slug: 'pack-one', title: 'Pack _[external link]_',
      summary: 'Read [external link].', categories: ['technology'], minecraftVersions: ['1.21.1'], loaders: ['fabric'],
      serverCompatibility: 'required', updatedAt: '2026-08-01T00:00:00.000Z', downloads: 123,
      iconUrlCandidate: 'https://cdn.modrinth.com/data/icon.png',
      galleryUrlCandidates: ['https://cdn.modrinth.com/data/gallery.png']
    }],
    pagination: { offset: 20, limit: 20, total: 61 }
  });
});

test('public ModpackError codes survive while native errors and unsafe service output are redacted', async () => {
  const first = createFixture();
  first.dependencies.lifecycleService.getJob = async () => {
    throw new ModpackError('PLAN_STALE', 'The reviewed modpack plan is stale');
  };
  const stale = await first.handlers['modpacks:get-job']({}, { jobId: 'job-one' });
  assert.equal(stale.error.code, 'PLAN_STALE');

  const limitedFixture = createFixture();
  limitedFixture.dependencies.providers.github.listReleases = async () => {
    const error = new ModpackError('RATE_LIMITED', 'GitHub request is rate limited', { retryable: true });
    Object.defineProperty(error, 'retryMetadata', {
      value: Object.freeze({ retryAfterMs: 5000, backoffMs: 1000, nextAttemptAfterMs: 5000 }),
      enumerable: false
    });
    throw error;
  };
  const limited = await limitedFixture.handlers['modpacks:list-github-releases']({}, {
    repositoryUrl: 'https://github.com/owner/pack',
    includePrereleases: false
  });
  assert.deepEqual(limited, {
    ok: false,
    error: {
      code: 'RATE_LIMITED',
      message: 'GitHub request is rate limited',
      details: {},
      retryable: true
    }
  });
  assert.doesNotMatch(JSON.stringify(limited), /retryMetadata|retryAfterMs/);

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

test('inspection progress is correlated, sender-scoped, and strips the client request ID before lifecycle validation', async () => {
  const fixture = createFixture();
  const sent = [];
  let received;
  fixture.dependencies.lifecycleService.inspectSource = async (request, { onProgress }) => {
    received = request;
    onProgress({ phase: 'resolving' });
    onProgress({ phase: 'downloading', transferredBytes: 24, totalBytes: 48, percent: 50 });
    return { inspectionId: 'inspection-one' };
  };
  const handlers = createModpackHandlers(fixture.dependencies);

  const result = await handlers['modpacks:inspect']({ sender: { send: (...args) => sent.push(args) } }, {
    provider: 'modrinth', projectId: 'project-one', versionId: 'version-one', requestId: 'inspect-client-one'
  });

  assert.equal(result.ok, true);
  assert.deepEqual(received, { provider: 'modrinth', projectId: 'project-one', versionId: 'version-one' });
  assert.deepEqual(sent, [
    ['modpacks:inspection-progress', { requestId: 'inspect-client-one', phase: 'resolving' }],
    ['modpacks:inspection-progress', {
      requestId: 'inspect-client-one', phase: 'downloading', transferredBytes: 24, totalBytes: 48, percent: 50
    }]
  ]);
});

test('inspection progress coalesces chunk floods while preserving ordered phases and exact completion', async () => {
  const fixture = createFixture();
  const sent = [];
  fixture.dependencies.lifecycleService.inspectSource = async (_request, { onProgress }) => {
    onProgress({ phase: 'resolving' });
    const totalBytes = 10_000;
    for (let transferredBytes = 0; transferredBytes <= totalBytes; transferredBytes += 1) {
      onProgress({
        phase: 'downloading', transferredBytes, totalBytes,
        percent: Math.floor((transferredBytes * 100) / totalBytes)
      });
    }
    for (const phase of ['verifying', 'materialize', 'list', 'validate', 'classify', 'complete']) {
      onProgress({ phase });
    }
    return { inspectionId: 'inspection-one' };
  };
  const handlers = createModpackHandlers(fixture.dependencies);

  const result = await handlers['modpacks:inspect']({ sender: { send: (...args) => sent.push(args) } }, {
    provider: 'modrinth', projectId: 'project-one', versionId: 'version-one', requestId: 'inspect-client-flood'
  });

  assert.equal(result.ok, true);
  assert.ok(sent.length <= 120, `expected at most 120 renderer events, received ${sent.length}`);
  assert.deepEqual(
    sent.map(([, event]) => event.phase).filter((phase, index, phases) => index === 0 || phase !== phases[index - 1]),
    ['resolving', 'downloading', 'verifying', 'materialize', 'list', 'validate', 'classify', 'complete']
  );
  const downloads = sent.map(([, event]) => event).filter(event => event.phase === 'downloading');
  assert.deepEqual(downloads.at(-1), {
    requestId: 'inspect-client-flood', phase: 'downloading',
    transferredBytes: 10_000, totalBytes: 10_000, percent: 100
  });
  assert.deepEqual(sent.at(-1), [
    'modpacks:inspection-progress',
    { requestId: 'inspect-client-flood', phase: 'complete' }
  ]);
  assert.ok(sent.every(([, event]) => event.requestId === 'inspect-client-flood'));
});

test('preflight progress coalesces download chunk floods while preserving activities and exact completion', async () => {
  const fixture = createFixture();
  const sent = [];
  fixture.dependencies.lifecycleService.createPlan = async (_request, { onProgress }) => {
    onProgress({ phase: 'validating-destination' });
    const totalBytes = 10_000;
    for (let processedBytes = 0; processedBytes < totalBytes; processedBytes += 1) {
      onProgress({
        phase: 'preparing-candidate', activity: 'downloading-pack-files',
        completedItems: 0, totalItems: 1, processedBytes, totalBytes
      });
    }
    onProgress({
      phase: 'preparing-candidate', activity: 'downloading-pack-files',
      completedItems: 1, totalItems: 1, processedBytes: totalBytes, totalBytes
    });
    for (const activity of ['assembling-files', 'hashing-candidate-files']) {
      onProgress({ phase: 'preparing-candidate', activity });
    }
    for (const phase of [
      'scanning-server', 'calculating-changes', 'checking-capacity', 'sealing-plan', 'complete'
    ]) {
      onProgress({ phase });
    }
    return { planId: 'plan-one' };
  };
  const handlers = createModpackHandlers(fixture.dependencies);

  const result = await handlers['modpacks:preflight']({ sender: { send: (...args) => sent.push(args) } }, {
    ...structuredClone(VALID_REQUESTS['modpacks:preflight']), requestId: 'preflight-client-flood'
  });

  assert.equal(result.ok, true);
  assert.ok(sent.length <= 12, `expected at most 12 renderer events, received ${sent.length}`);
  assert.deepEqual(sent.map(([, event]) => `${event.phase}:${event.activity || ''}`), [
    'validating-destination:',
    'preparing-candidate:downloading-pack-files',
    'preparing-candidate:downloading-pack-files',
    'preparing-candidate:assembling-files',
    'preparing-candidate:hashing-candidate-files',
    'scanning-server:',
    'calculating-changes:',
    'checking-capacity:',
    'sealing-plan:',
    'complete:'
  ]);
  const downloads = sent.map(([, event]) => event)
    .filter(event => event.activity === 'downloading-pack-files');
  assert.deepEqual(downloads.at(-1), {
    requestId: 'preflight-client-flood', phase: 'preparing-candidate', activity: 'downloading-pack-files',
    completedItems: 1, totalItems: 1, processedBytes: 10_000, totalBytes: 10_000
  });
  assert.ok(sent.every(([, event]) => event.requestId === 'preflight-client-flood'));
});

test('inspection progress events reject unknown fields and authority-bearing values', () => {
  const event = validateModpackIpcEvent('modpacks:inspection-progress', {
    requestId: 'inspect-client-one', phase: 'downloading', transferredBytes: 24, totalBytes: 48, percent: 50
  });
  assert.equal(Object.isFrozen(event), true);
  for (const unsafe of [
    { requestId: 'inspect-client-one', phase: 'downloading', url: 'https://example.invalid/private' },
    { requestId: 'inspect-client-one', phase: 'downloading', sourcePath: 'C:\\private\\archive.zip' },
    { requestId: 'inspect-client-one', phase: 'downloading', transferredBytes: -1 },
    { requestId: 'inspect-client-one', phase: 'unknown' }
  ]) {
    assert.throws(() => validateModpackIpcEvent('modpacks:inspection-progress', unsafe), error => error.code === 'INVALID_REQUEST');
  }
});

test('inspection cancellation is scoped to the exact renderer and aborts the active lifecycle request', async () => {
  const fixture = createFixture();
  let observedSignal = null;
  let markStarted;
  const started = new Promise(resolve => { markStarted = resolve; });
  fixture.dependencies.lifecycleService.inspectSource = async (_request, { signal }) => {
    observedSignal = signal;
    markStarted();
    await new Promise((resolve, reject) => {
      const onAbort = () => reject(new ModpackError('CANCELLED', 'Archive inspection was cancelled'));
      if (signal.aborted) onAbort();
      else signal.addEventListener('abort', onAbort, { once: true });
    });
  };
  const handlers = createModpackHandlers(fixture.dependencies);
  const sender = { id: 41, send() {} };
  const inspection = handlers['modpacks:inspect']({ sender }, {
    provider: 'modrinth', projectId: 'project-one', versionId: 'version-one', requestId: 'inspect-client-cancel'
  });
  await started;

  const foreign = await handlers['modpacks:cancel-inspection']({ sender: { id: 42 } }, {
    requestId: 'inspect-client-cancel'
  });
  assert.deepEqual(foreign, { ok: true, value: false });
  assert.equal(observedSignal.aborted, false);

  const cancelled = await handlers['modpacks:cancel-inspection']({ sender }, {
    requestId: 'inspect-client-cancel'
  });
  assert.deepEqual(cancelled, { ok: true, value: true });
  assert.equal(observedSignal.aborted, true);
  assert.equal((await inspection).error.code, 'CANCELLED');
});

test('completed opaque inspection handles can be discarded only by the renderer that created them', async () => {
  const fixture = createFixture();
  fixture.dependencies.lifecycleService.inspectSource = async () => ({ inspectionId: 'inspection-reviewed-one' });
  const handlers = createModpackHandlers(fixture.dependencies);
  const owner = { id: 41, send() {} };
  const inspected = await handlers['modpacks:inspect']({ sender: owner }, {
    provider: 'modrinth', projectId: 'project-one', versionId: 'version-one'
  });
  assert.equal(inspected.ok, true);

  const foreign = await handlers['modpacks:cancel-inspection']({ sender: { id: 42 } }, {
    inspectionId: 'inspection-reviewed-one'
  });
  assert.deepEqual(foreign, { ok: true, value: false });
  assert.equal(fixture.calls.some(([name]) => name === 'cancelInspection'), false);

  const result = await handlers['modpacks:cancel-inspection']({ sender: owner }, {
    inspectionId: 'inspection-reviewed-one'
  });
  assert.deepEqual(result, { ok: true, value: { kind: 'cancelInspection', request: 'inspection-reviewed-one' } });
  assert.deepEqual(fixture.calls.at(-1), ['cancelInspection', 'inspection-reviewed-one']);
});
