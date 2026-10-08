const test = require('node:test');
const assert = require('node:assert/strict');

const {
  validateModpackIpcEvent,
  validateModpackIpcRequest,
  validateModpackIpcResult,
  validateSchema
} = require('../../electron/services/modpacks/ipc-schemas.cjs');

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
