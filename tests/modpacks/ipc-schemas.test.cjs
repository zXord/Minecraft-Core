const test = require('node:test');
const assert = require('node:assert/strict');

const {
  validateModpackIpcEvent,
  validateModpackIpcRequest,
  validateModpackIpcResult,
  validateSchema
} = require('../../electron/services/modpacks/ipc-schemas.cjs');

function activeJob() {
  return { type: 'minecraft-core-modpack-job', schemaVersion: 1, sequence: 0, jobId: 'job-one',
    operationKind: 'repair', serverId: 'server-one', planFingerprint: null, phase: 'queued', swapStep: null,
    progress: null, cancellationRequested: false, createdAt: '2026-10-10T00:00:00.000Z',
    updatedAt: '2026-10-10T00:00:00.000Z', terminalAt: null, outcome: null, events: [] };
}

const launchChannel = 'modpacks:reconcile-new-server-launch';
const launchListChannel = 'modpacks:list-new-server-launches';
const launchCredentials = {
  planId: 'plan-launch-v1-12345678-1234-4234-8234-123456789abc', planFingerprint: 'a'.repeat(64)
};
const launchCursor = 'launch-cursor-v1-12345678-1234-4234-8234-123456789abc';
const launchReasons = ['admission-unresolved', 'missing-recovery-evidence', 'conflicting-evidence',
  'invalid-durable-evidence', 'pending-terminal-publication', 'settlement-repair-required',
  'destination-recovery', 'legacy-origin-unproven'];
function launchJob() {
  return { ...activeJob(), operationKind: 'install-new', planFingerprint: launchCredentials.planFingerprint };
}
function launchStarted(settlement = { status: 'active', destinationDisposition: 'held', recoveryAvailable: false }) {
  return { ...launchCredentials, status: 'started', job: launchJob(), settlement };
}
function launchSummary() {
  return { ...launchCredentials, status: 'started', createdAt: '2026-10-10T00:00:00.000Z',
    serverId: 'server-one', operationKind: 'install-new', displayName: 'My server', jobId: 'job-one',
    settlement: { status: 'settled', destinationDisposition: 'consumed', recoveryAvailable: false } };
}
function checkLaunch(value, request = launchCredentials) {
  return validateModpackIpcResult(launchChannel, { ok: true, value }, request).value;
}
function checkLaunchList(value, request = {}) {
  return validateModpackIpcResult(launchListChannel, { ok: true, value }, request).value;
}

test('launch requests close credentials and bounded opaque cursor pagination without changing start or release', () => {
  for (const request of [launchCredentials, { ...launchCredentials, planId: 'legacy-plan-one' }]) {
    assert.deepEqual(validateModpackIpcRequest(launchChannel, request), request);
  }
  for (const request of [{}, { ...launchCredentials, extra: true }, { ...launchCredentials, planId: '' },
    { ...launchCredentials, planId: 'a'.repeat(129) }, { ...launchCredentials, planId: 'C:\\private' },
    { ...launchCredentials, planFingerprint: 'A'.repeat(64) }, { ...launchCredentials, ownerEpoch: 'epoch' }]) {
    assert.throws(() => validateModpackIpcRequest(launchChannel, request), { code: 'INVALID_REQUEST' });
  }
  for (const request of [{}, { limit: 1 }, { limit: 100 }, { cursor: launchCursor, limit: 50 }]) {
    assert.deepEqual(validateModpackIpcRequest(launchListChannel, request), request);
  }
  for (const request of [{ limit: 0 }, { limit: 101 }, { limit: 1.5 }, { limit: '50' }, { cursor: null },
    { cursor: '0' }, { cursor: launchCursor.replace('-4234-', '-1234-') },
    { cursor: launchCursor.replace('-8234-', '-7234-') }, { cursor: `${launchCursor}x` },
    { cursor: launchCursor.toUpperCase() }, { offset: 0 }, { snapshot: 'private' }]) {
    assert.throws(() => validateModpackIpcRequest(launchListChannel, request), { code: 'INVALID_REQUEST' });
  }
  assert.deepEqual(validateModpackIpcRequest('modpacks:start-operation', { ...launchCredentials, choices: {} }),
    { ...launchCredentials, choices: {} });
  assert.deepEqual(validateModpackIpcRequest('modpacks:reserve-server-destination', {}), {});
  assert.deepEqual(validateModpackIpcRequest('modpacks:release-server-destination', { instanceId: 'server-one' }),
    { instanceId: 'server-one' });
});

test('launch reconciliation accepts every closed status with exact request and public v1 job identity', () => {
  for (const value of [
    { ...launchCredentials, status: 'pending' },
    { ...launchCredentials, status: 'pending', reason: 'admission-unresolved' },
    { ...launchCredentials, status: 'not-observed' }, { ...launchCredentials, status: 'not-started' },
    ...launchReasons.map(reason => ({ ...launchCredentials, status: 'recovery-required', reason })),
    { ...launchCredentials, planId: 'legacy-plan-one', status: 'unavailable', reason: 'legacy-correlation-unavailable' },
    launchStarted(), { ...launchStarted(), job: { ...launchJob(), operationKind: 'import-files-only-new' } }
  ]) {
    const result = checkLaunch(value, { planId: value.planId, planFingerprint: value.planFingerprint });
    assert.deepEqual(result, value);
    assert.equal(Object.isFrozen(result), true);
    if (result.job) assert.equal(Object.isFrozen(result.job), true);
  }
  for (const value of [{ ...launchCredentials, status: 'unknown' },
    { ...launchCredentials, status: 'pending', reason: 'missing-recovery-evidence' },
    { ...launchCredentials, status: 'not-started', reason: 'admission-unresolved' },
    { ...launchCredentials, status: 'not-observed', job: launchJob() },
    { ...launchCredentials, status: 'recovery-required' },
    { ...launchCredentials, status: 'recovery-required', reason: 'C:\\private' },
    { ...launchCredentials, status: 'unavailable', reason: 'legacy-origin-unproven' },
    { ...launchStarted(), job: { ...launchJob(), schemaVersion: 2 } },
    { ...launchStarted(), job: { ...launchJob(), checksum: 'a'.repeat(64) } },
    { ...launchStarted(), job: { ...launchJob(), operationKind: 'repair' } },
    { ...launchStarted(), job: { ...launchJob(), planFingerprint: 'b'.repeat(64) } },
    { ...launchStarted(), job: { ...launchJob(), sequence: -1 } },
    { ...launchCredentials, status: 'not-started', planFingerprint: 'b'.repeat(64) },
    { ...launchCredentials, status: 'not-started', planId: 'another-plan' }]) {
    assert.throws(() => checkLaunch(value), { code: 'INVALID_REQUEST' });
  }
  assert.throws(() => checkLaunch(launchStarted(), null), { code: 'INVALID_REQUEST' });
  const errorResult = { ok: false, error: { code: 'LAUNCH_CURSOR_EXPIRED',
    message: 'The setup list expired. Refresh it to continue.', details: {}, retryable: true } };
  assert.deepEqual(validateModpackIpcResult(launchChannel, errorResult), errorResult);
  assert.deepEqual(validateModpackIpcResult(launchListChannel, errorResult), errorResult);
});

test('launch settlement validates status disposition reason and recovery availability independently from terminal phase', () => {
  const settlements = [
    ...['held', 'released', 'consumed'].map(destinationDisposition => ({ status: 'active', destinationDisposition, recoveryAvailable: false })),
    ...['released', 'consumed'].map(destinationDisposition => ({ status: 'settled', destinationDisposition, recoveryAvailable: false })),
    ...['repair-pending', 'recovery-required', 'support-required'].flatMap(status => launchReasons.map(reason => ({
      status, destinationDisposition: 'held', reason, recoveryAvailable: status === 'recovery-required'
    })))
  ];
  for (const settlement of settlements) {
    const value = launchStarted(settlement);
    assert.deepEqual(checkLaunch(value), value);
  }
  for (const destinationDisposition of ['released', 'consumed']) {
    const settlement = { status: 'support-required', destinationDisposition, reason: 'conflicting-evidence', recoveryAvailable: false };
    assert.deepEqual(checkLaunch(launchStarted(settlement)), launchStarted(settlement));
    const summary = { ...launchSummary(), settlement };
    assert.deepEqual(checkLaunchList({ items: [summary], nextCursor: null }), { items: [summary], nextCursor: null });
  }
  const terminal = { ...launchStarted(settlements.at(-1)), job: { ...launchJob(), phase: 'cancelled',
    terminalAt: '2026-10-10T00:00:00.000Z', outcome: { status: 'cancelled', message: 'Operation cancelled' } } };
  assert.deepEqual(checkLaunch(terminal), terminal);
  for (const settlement of [
    { status: 'settled', destinationDisposition: 'held', recoveryAvailable: false },
    { status: 'active', destinationDisposition: 'held', reason: 'admission-unresolved', recoveryAvailable: false },
    { status: 'active', destinationDisposition: 'held', recoveryAvailable: true },
    { status: 'repair-pending', destinationDisposition: 'released', reason: 'settlement-repair-required', recoveryAvailable: false },
    { status: 'recovery-required', destinationDisposition: 'consumed', reason: 'conflicting-evidence', recoveryAvailable: true },
    { status: 'support-required', destinationDisposition: 'held', recoveryAvailable: false },
    { status: 'support-required', destinationDisposition: 'held', reason: 'conflicting-evidence', recoveryAvailable: true },
    { status: 'recovery-required', destinationDisposition: 'held', reason: 'destination-recovery', recoveryAvailable: false },
    { status: 'repair-pending', destinationDisposition: 'held', reason: 'raw error', recoveryAvailable: false },
    { status: 'active', destinationDisposition: 'unknown', recoveryAvailable: false },
    { status: 'active', destinationDisposition: 'held' }
  ]) assert.throws(() => checkLaunch(launchStarted(settlement)), { code: 'INVALID_REQUEST' });
});

test('launch lists close safe summaries canonical dates names and cursor without full jobs', () => {
  const summary = launchSummary();
  for (const status of ['pending', 'not-observed', 'not-started', 'recovery-required', 'unavailable']) {
    for (const item of [
      { ...launchCredentials, status, createdAt: summary.createdAt },
      { ...launchCredentials, status, createdAt: summary.createdAt,
        serverId: 'server-one', operationKind: 'import-files-only-new', displayName: 'My server' }
    ]) assert.deepEqual(checkLaunchList({ items: [item], nextCursor: null }), { items: [item], nextCursor: null });
  }
  assert.deepEqual(checkLaunchList({ items: [summary], nextCursor: launchCursor }), { items: [summary], nextCursor: launchCursor });
  assert.deepEqual(checkLaunchList({ items: [], nextCursor: null }), { items: [], nextCursor: null });
  for (const key of ['serverId', 'operationKind', 'displayName', 'jobId', 'settlement']) {
    const item = { ...summary }; delete item[key];
    assert.throws(() => checkLaunchList({ items: [item], nextCursor: null }), { code: 'INVALID_REQUEST' });
  }
  for (const item of [
    { ...summary, job: launchJob() }, { ...summary, extra: true }, { ...summary, status: 'unknown' },
    { ...summary, status: 'pending' }, { ...summary, operationKind: 'repair' },
    { ...summary, createdAt: '2026-10-10T00:00:00Z' }, { ...summary, createdAt: '2026-02-30T00:00:00.000Z' },
    ...['', ' My server', 'My server ', 'CON', 'bad/name', 'bad\u0000name', 'x'.repeat(129), 'Cafe\u0301'].map(displayName => ({ ...summary, displayName })),
    { ...summary, settlement: { ...summary.settlement, destinationDisposition: 'held' } },
    { ...summary, serverId: 'C:\\private' }
  ]) assert.throws(() => checkLaunchList({ items: [item], nextCursor: null }), { code: 'INVALID_REQUEST' });
  for (const value of [{ items: [summary] }, { items: [], nextCursor: 'offset-50' },
    { items: [], nextCursor: null, snapshot: 'private' }, { items: [summary, summary], nextCursor: null },
    { items: Array.from({ length: 101 }, (_, n) => ({ ...summary, planId: `plan-${n}` })), nextCursor: null }]) {
    assert.throws(() => checkLaunchList(value), { code: 'INVALID_REQUEST' });
  }
});

test('launch destination disposition exception is exact and never admits private binding authority', () => {
  for (const extra of [{ destinationDisposition: 'held' }, { launchBinding: {} }, { recordRevision: {} },
    { ownerEpoch: 'private' }, { publicationGeneration: 1 }, { targetPath: 'C:\\private' },
    { capturedReservation: { kind: 'absent' } }, { rawError: 'failure' }]) {
    assert.throws(() => checkLaunch({ ...launchStarted(), ...extra }), { code: 'INVALID_REQUEST' });
    assert.throws(() => checkLaunchList({ items: [{ ...launchSummary(), ...extra }], nextCursor: null }), { code: 'INVALID_REQUEST' });
  }
  for (const extra of [{ destination: 'held' }, { destinationDispositionExtra: 'held' }, { path: 'C:\\private' },
    { nested: { destinationDisposition: 'held' } }, { binding: {} }]) {
    assert.throws(() => checkLaunch(launchStarted({ ...launchStarted().settlement, ...extra })), { code: 'INVALID_REQUEST' });
  }
  assert.throws(() => validateModpackIpcResult('modpacks:get-state', {
    ok: true, value: { settlement: { destinationDisposition: 'held' } }
  }), { code: 'INVALID_REQUEST' });
});

test('launch public v1 job outcome and event details cannot hide private launch bookkeeping', () => {
  for (const privateField of ['launchBinding', 'binding', 'checksum', 'recordRevision', 'ownerEpoch',
    'admissionGeneration', 'publicationGeneration', 'capturedReservation', 'snapshot', 'rawError']) {
    const hidden = { [privateField]: 'private' };
    const outcomeJob = { ...launchJob(), phase: 'failed', terminalAt: '2026-10-10T00:00:00.000Z',
      outcome: { status: 'failed', message: 'Operation failed', nested: hidden } };
    const eventJob = { ...launchJob(), sequence: 1, events: [{ sequence: 1, jobId: 'job-one', channel: 'log',
      phase: 'queued', timestamp: '2026-10-10T00:00:00.000Z', message: 'Operation queued', progress: null,
      currentItem: null, details: { nested: hidden } }] };
    for (const job of [outcomeJob, eventJob]) {
      assert.throws(() => checkLaunch({ ...launchStarted(), job }), { code: 'INVALID_REQUEST' }, privateField);
    }
  }
});

test('active jobs transport closes selector result ownership and public job bindings', () => {
  const channel = 'modpacks:get-active-jobs';
  assert.deepEqual(validateModpackIpcRequest(channel, { serverId: 'server-one' }), { serverId: 'server-one' });
  for (const request of [{}, { serverId: 'server-one', extra: true }, { serverId: 'server-one', path: 'C:\\private' }]) {
    assert.throws(() => validateModpackIpcRequest(channel, request));
  }
  const value = { serverId: 'server-one', items: [{ ownership: 'running', job: activeJob() }] };
  assert.deepEqual(validateModpackIpcResult(channel, { ok: true, value }).value, value);
  for (const bad of [
    { ...value, extra: true },
    { ...value, items: [{ ownership: 'unknown', job: activeJob() }] },
    { ...value, items: [{ ownership: 'settling', job: activeJob() }] },
    { ...value, items: [{ ownership: 'running', job: { ...activeJob(), serverId: 'server-two' } }] },
    { ...value, items: [{ ownership: 'running', job: { ...activeJob(), serverPath: 'C:\\private' } }] },
    { ...value, items: [{ ownership: 'running', job: { ...activeJob(), phase: 'bogus' } }] }
  ]) assert.throws(() => validateModpackIpcResult(channel, { ok: true, value: bad }));
  assert.throws(() => validateModpackIpcResult(channel, { ok: true, value }, { serverId: 'server-two' }));
});

test('schema validation clones and freezes a valid runtime tuple', () => {
  const input = {
    minecraftVersion: '1.21.1', loaderFamily: 'fabric', loaderVersion: '0.16.14', javaMajor: 21, os: 'win32', architecture: 'x64'
  };

  const result = validateSchema('RuntimeTuple', input);
  input.loaderVersion = 'mutated';

  assert.equal(result.loaderVersion, '0.16.14');
  assert.equal(Object.isFrozen(result), true);
});

test('schema validation rejects unknown fields and never accepts renderer path fields', () => {
  assert.throws(
    () => validateSchema('RuntimeTuple', {
      minecraftVersion: '1.21.1', loaderFamily: 'fabric', loaderVersion: '0.16.14', javaMajor: 21, os: 'win32', architecture: 'x64', serverPath: 'C:\\server'
    }),
    error => error.code === 'INVALID_REQUEST'
  );
});

test('public modpack error results accept only code-specific declared details', () => {
  const result = validateSchema('PublicModpackErrorResult', {
    ok: false,
    error: {
      code: 'HASH_MISMATCH',
      message: 'Integrity check failed',
      details: { algorithm: 'sha512' },
      retryable: false
    }
  });

  assert.deepEqual(result.error.details, { algorithm: 'sha512' });
  assert.throws(
    () => validateSchema('PublicModpackErrorResult', {
      ok: false,
      error: { code: 'HASH_MISMATCH', message: 'Integrity check failed', details: { url: 'https://x/?token=y' }, retryable: false }
    }),
    error => error.code === 'INVALID_REQUEST'
  );
});

test('schema validation converts cyclic and BigInt serialization failures into INVALID_REQUEST', () => {
  const cyclic = {
    minecraftVersion: '1.21.1', loaderFamily: 'fabric', loaderVersion: '0.16.14', javaMajor: 21, os: 'win32', architecture: 'x64'
  };
  cyclic.self = cyclic;
  const bigint = {
    minecraftVersion: '1.21.1', loaderFamily: 'fabric', loaderVersion: '0.16.14', javaMajor: 21n, os: 'win32', architecture: 'x64'
  };

  assert.throws(() => validateSchema('RuntimeTuple', cyclic), error => error.code === 'INVALID_REQUEST');
  assert.throws(() => validateSchema('RuntimeTuple', bigint), error => error.code === 'INVALID_REQUEST');
});

test('preflight accepts only the schema-defined conflictChoices.paths map and still rejects path authority', () => {
  const request = {
    inspectionId: 'inspection-1',
    instanceId: 'server-1',
    operationKind: 'install-existing',
    selections: {
      optionalFileIds: [],
      conflictChoices: {
        paths: { 'conflict.path.one': { choice: 'keep-mine' } },
        categories: { configuration: 'keep-mine' }
      },
      acknowledgeMissingProviderDigest: false,
      selectedRoot: 'Reviewed server root',
      runtimeChoice: {
        minecraftVersion: '1.21.1', loaderFamily: 'fabric', loaderVersion: '0.16.14'
      }
    }
  };

  assert.deepEqual(validateModpackIpcRequest('modpacks:preflight', request), request);
  for (const invalid of [
    { ...request, paths: {} },
    { ...request, selections: { ...request.selections, paths: {} } },
    { ...request, selections: { ...request.selections, conflictChoices: { ...request.selections.conflictChoices, path: 'server' } } },
    {
      ...request,
      selections: {
        ...request.selections,
        conflictChoices: { paths: { 'conflict.path.one': { choice: 'keep-both', alternateId: 'C:\\private\\server' } } }
      }
    },
    { ...request, selections: { ...request.selections, selectedRoot: '..\\outside' } },
    { ...request, selections: { ...request.selections, runtimeChoice: { ...request.selections.runtimeChoice, javaMajor: 21 } } },
    { ...request, selections: { ...request.selections, runtimeChoice: { ...request.selections.runtimeChoice, loaderFamily: 'unknown' } } }
  ]) {
    assert.throws(
      () => validateModpackIpcRequest('modpacks:preflight', invalid),
      error => error.code === 'INVALID_REQUEST'
    );
  }
});

test('new-server preflight accepts only bounded reviewed RAM and network choices', () => {
  const request = {
    inspectionId: 'inspection-ram',
    instanceId: 'server-ram',
    operationKind: 'install-new',
    selections: {
      optionalFileIds: [],
      conflictChoices: { paths: {}, categories: {} },
      acknowledgeMissingProviderDigest: false,
      acknowledgeDowngradeWorldRisk: false,
      selectedRoot: null,
      runtimeChoice: null,
      maxRam: 6,
      serverPort: 25571,
      networkAccess: 'loopback'
    }
  };

  assert.deepEqual(validateModpackIpcRequest('modpacks:preflight', request), request);
  for (const maxRam of [0, 1.5, 65, '6']) {
    assert.throws(
      () => validateModpackIpcRequest('modpacks:preflight', {
        ...request, selections: { ...request.selections, maxRam }
      }),
      error => error.code === 'INVALID_REQUEST'
    );
  }
  for (const serverPort of [1024, 1.5, 65536, '25571']) {
    assert.throws(
      () => validateModpackIpcRequest('modpacks:preflight', {
        ...request, selections: { ...request.selections, serverPort }
      }),
      error => error.code === 'INVALID_REQUEST'
    );
  }
  for (const networkAccess of ['', 'public', true]) {
    assert.throws(
      () => validateModpackIpcRequest('modpacks:preflight', {
        ...request, selections: { ...request.selections, networkAccess }
      }),
      error => error.code === 'INVALID_REQUEST'
    );
  }
});

test('preflight progress exposes only closed stages, candidate activities, and aggregate measurements', () => {
  const event = {
    requestId: 'preflight-one',
    phase: 'preparing-candidate',
    activity: 'downloading-pack-files',
    completedItems: 2,
    totalItems: 4,
    processedBytes: 512,
    totalBytes: 1024
  };

  assert.deepEqual(validateModpackIpcEvent('modpacks:preflight-progress', event), event);
  for (const unsafe of [
    { ...event, activity: 'reading-file-name' },
    { ...event, completedItems: -1 },
    { ...event, completedItems: 5 },
    { ...event, processedBytes: 1025 },
    { ...event, totalBytes: undefined },
    { ...event, phase: 'scanning-server' },
    { ...event, fileName: 'private-pack.mrpack' },
    { ...event, path: 'C:\\private\\pack.mrpack' }
  ]) {
    assert.throws(
      () => validateModpackIpcEvent('modpacks:preflight-progress', unsafe),
      error => error.code === 'INVALID_REQUEST'
    );
  }
});

test('management preflight accepts an opaque correlation id without accepting renderer authority', () => {
  const request = {
    serverId: 'server-one',
    operationKind: 'rollback-restore-point',
    selectionRef: 'restore-one',
    requestId: 'preflight-management-one'
  };
  assert.deepEqual(validateModpackIpcRequest('modpacks:preflight-management', request), request);
  assert.throws(
    () => validateModpackIpcRequest('modpacks:preflight-management', {
      ...request,
      serverPath: 'C:\\private\\server'
    }),
    error => error.code === 'INVALID_REQUEST'
  );
});

test('restore-point verification progress exposes aggregate bytes without file names or paths', () => {
  const event = {
    requestId: 'preflight-management-one',
    phase: 'verifying-restore-point',
    activity: 'verifying-archive',
    processedBytes: 512,
    totalBytes: 1024
  };
  assert.deepEqual(validateModpackIpcEvent('modpacks:preflight-progress', event), event);
  for (const unsafe of [
    { ...event, processedBytes: 1025 },
    { ...event, fileName: 'private-backup.zip' },
    { ...event, path: 'C:\\private\\backup.zip' }
  ]) {
    assert.throws(
      () => validateModpackIpcEvent('modpacks:preflight-progress', unsafe),
      error => error.code === 'INVALID_REQUEST'
    );
  }
});

test('preflight rejects operation names that are not executable by the public planning adapter', () => {
  const request = {
    inspectionId: 'inspection-1',
    instanceId: 'server-1',
    operationKind: 'verify',
    selections: {
      optionalFileIds: [],
      conflictChoices: { paths: {} },
      acknowledgeMissingProviderDigest: false,
      selectedRoot: 'Reviewed server root',
      runtimeChoice: {
        minecraftVersion: '1.21.1', loaderFamily: 'fabric', loaderVersion: '0.16.14'
      }
    }
  };

  for (const operationKind of ['verify', 'uninstall-managed']) {
    assert.throws(
      () => validateModpackIpcRequest('modpacks:preflight', { ...request, operationKind }),
      error => error.code === 'INVALID_REQUEST'
    );
  }
});

test('safe outcome actions expose only the typed destination DTO, never destination authority', () => {
  const result = {
    ok: true,
    value: {
      type: 'outcome-action-result', actionId: 'open-details', status: 'ready',
      destination: { kind: 'details', targetId: 'job-one' }
    }
  };
  assert.deepEqual(validateModpackIpcResult('modpacks:perform-safe-action', result), result);
  assert.throws(
    () => validateModpackIpcResult('modpacks:perform-safe-action', {
      ...result,
      value: { ...result.value, destination: { ...result.value.destination, path: 'C:\\private\\server' } }
    }),
    error => error.code === 'INVALID_REQUEST'
  );

  const exactRelease = {
    ...result,
    value: {
      ...result.value,
      destination: {
        ...result.value.destination,
        targetId: 'release:tracking-one:2002',
        releaseTarget: {
          serverId: 'server-one', provider: 'github', sourceId: '1001',
          releaseId: '2002', prerelease: false
        }
      }
    }
  };
  assert.deepEqual(validateModpackIpcResult('modpacks:perform-safe-action', exactRelease), exactRelease);
  for (const authority of [
    { repositoryUrl: 'https://github.com/owner/repository' },
    { path: 'C:\\private\\server' },
    { accessToken: 'not-public' }
  ]) {
    assert.throws(
      () => validateModpackIpcResult('modpacks:perform-safe-action', {
        ...exactRelease,
        value: {
          ...exactRelease.value,
          destination: {
            ...exactRelease.value.destination,
            releaseTarget: { ...exactRelease.value.destination.releaseTarget, ...authority }
          }
        }
      }),
      error => error.code === 'INVALID_REQUEST'
    );
  }
});

test('inspection cancellation and destination release accept only one opaque identifier', () => {
  assert.deepEqual(
    validateModpackIpcRequest('modpacks:cancel-inspection', { requestId: 'inspect-client-one' }),
    { requestId: 'inspect-client-one' }
  );
  assert.deepEqual(
    validateModpackIpcRequest('modpacks:cancel-inspection', { inspectionId: 'inspection-reviewed-one' }),
    { inspectionId: 'inspection-reviewed-one' }
  );
  assert.deepEqual(
    validateModpackIpcRequest('modpacks:release-server-destination', { instanceId: 'server-reserved-one' }),
    { instanceId: 'server-reserved-one' }
  );
  for (const request of [
    {},
    { requestId: 'inspect-client-one', inspectionId: 'inspection-reviewed-one' },
    { requestId: 'C:\\private\\archive.zip' },
    { inspectionId: 'inspection-reviewed-one', extra: true }
  ]) {
    assert.throws(
      () => validateModpackIpcRequest('modpacks:cancel-inspection', request),
      error => error.code === 'INVALID_REQUEST'
    );
  }
  assert.throws(
    () => validateModpackIpcRequest('modpacks:release-server-destination', { instanceId: 'C:\\private\\server' }),
    error => error.code === 'INVALID_REQUEST'
  );
});
