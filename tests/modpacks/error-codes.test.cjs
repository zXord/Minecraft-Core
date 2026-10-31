const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const ts = require('typescript');

const {
  FAILURE_CODES,
  MODPACK_SERVICES_UNAVAILABLE_MESSAGE,
  ModpackError,
  PUBLIC_ERROR_DETAILS_BY_CODE,
  isValidPublicErrorResult
} = require('../../electron/services/modpacks/errors.cjs');

const APPROVED_CODES = [
  'INVALID_RELEASE_URL', 'RATE_LIMITED', 'REPOSITORY_NOT_FOUND', 'RELEASE_NOT_FOUND', 'ASSET_AMBIGUOUS', 'ASSET_SELECTION_REQUIRED', 'ASSET_CHANGED', 'ARTIFACT_UNAVAILABLE',
  'UNSUPPORTED_ARCHIVE', 'MAGIC_EXTENSION_MISMATCH', 'ENCRYPTED_ARCHIVE', 'MULTIPART_VOLUME_MISSING', 'ARCHIVE_LIMIT_EXCEEDED',
  'UNSAFE_ARCHIVE_ENTRY', 'ARCHIVE_ENTRY_COLLISION', 'EXTRACTOR_UNAVAILABLE', 'EXTRACTOR_FAILED', 'MANIFEST_INVALID', 'CLIENT_ONLY_PACK',
  'MISSING_PROVIDER_DIGEST', 'HASH_MISMATCH', 'PACK_ROOT_AMBIGUOUS', 'LOADER_CONFLICT', 'UNSUPPORTED_LOADER', 'UNSUPPORTED_RUNTIME_LAYOUT',
  'RUNTIME_INCOMPLETE', 'SERVER_PATH_TOO_LONG', 'DOWNGRADE_REQUIRED', 'SWITCH_REQUIRED', 'PLAN_STALE', 'SERVER_RUNNING', 'OPERATION_IN_PROGRESS', 'CANCELLED', 'TARGET_EXISTS', 'INSUFFICIENT_DISK',
  'BACKUP_FAILED', 'COMMIT_FAILED', 'HEALTH_CHECK_FAILED', 'ROLLBACK_FAILED', 'RECOVERY_REQUIRED', 'CLEANUP_FAILED', 'INVALID_REQUEST', 'NO_INSTALLABLE_ASSET', 'CLIENT_PACK_UNAVAILABLE', 'CLIENT_PACK_SERVER_CHANGED', 'CLIENT_RUNNING', 'MANAGED_MOD_EDIT_BLOCKED',
  'LAUNCH_CURSOR_EXPIRED', 'LAUNCH_DISCOVERY_CAPACITY', 'LAUNCH_LIST_LIMIT_EXCEEDED', 'MODPACK_SERVICES_UNAVAILABLE'
];

test('failure code registry contains exactly the approved public and boundary codes', () => {
  assert.deepEqual(FAILURE_CODES, APPROVED_CODES);
  assert.deepEqual(Object.keys(PUBLIC_ERROR_DETAILS_BY_CODE), APPROVED_CODES);
  assert.equal(Object.isFrozen(FAILURE_CODES), true);
  assert.equal(Object.isFrozen(PUBLIC_ERROR_DETAILS_BY_CODE), true);
});

test('renderer type contract accepts the runtime-direction failure codes', t => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'minecraft-core-modpack-types-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const declaration = path.resolve(__dirname, '../../src/types/modpack').replaceAll('\\', '/');
  const sourcePath = path.join(root, 'failure-code-contract.ts');
  fs.writeFileSync(sourcePath, [
    `import type { ModpackFailureCode } from ${JSON.stringify(declaration)};`,
    "const retryAsDowngrade: ModpackFailureCode = 'DOWNGRADE_REQUIRED';",
    "const retryAsSwitch: ModpackFailureCode = 'SWITCH_REQUIRED';",
    "const retryAfterRateLimit: ModpackFailureCode = 'RATE_LIMITED';",
    "const retryAtShorterPath: ModpackFailureCode = 'SERVER_PATH_TOO_LONG';",
    "const missingPublishedFile: ModpackFailureCode = 'ARTIFACT_UNAVAILABLE';",
    "const pairClient: ModpackFailureCode = 'CLIENT_PACK_UNAVAILABLE';",
    "const refuseManagedModEdit: ModpackFailureCode = 'MANAGED_MOD_EDIT_BLOCKED';",
    "const stopClient: ModpackFailureCode = 'CLIENT_RUNNING';",
    "const refreshSetupList: ModpackFailureCode = 'LAUNCH_CURSOR_EXPIRED';",
    "const retrySetupList: ModpackFailureCode = 'LAUNCH_DISCOVERY_CAPACITY';",
    "const useExactSetup: ModpackFailureCode = 'LAUNCH_LIST_LIMIT_EXCEEDED';",
    "const modpackFeaturesOff: ModpackFailureCode = 'MODPACK_SERVICES_UNAVAILABLE';",
    'void retryAsDowngrade;',
    'void retryAsSwitch;',
    'void retryAfterRateLimit;',
    'void retryAtShorterPath;',
    'void refuseManagedModEdit;',
    'void modpackFeaturesOff;'
  ].join('\n'));
  const program = ts.createProgram([sourcePath], {
    noEmit: true, strict: true, skipLibCheck: true,
    module: ts.ModuleKind.NodeNext, moduleResolution: ts.ModuleResolutionKind.NodeNext,
    target: ts.ScriptTarget.ES2022
  });
  const diagnostics = ts.getPreEmitDiagnostics(program);
  assert.deepEqual(diagnostics.map(diagnostic => ts.flattenDiagnosticMessageText(diagnostic.messageText, '\n')), []);
});

for (const { code, message, retryable } of [
  { code: 'LAUNCH_CURSOR_EXPIRED', message: 'The setup list expired. Refresh it to continue.', retryable: true },
  { code: 'LAUNCH_DISCOVERY_CAPACITY', message: 'The setup list is busy. Try again shortly.', retryable: true },
  { code: 'LAUNCH_LIST_LIMIT_EXCEEDED', message: 'Too many setups are available to list. Use an exact setup reference.', retryable: false }
]) {
  test(`${code} preserves its caller message and retryability with closed empty details`, () => {
    const privateDetails = {
      cursor: 'private-cursor',
      path: 'C:\\secret\\server',
      snapshot: { id: 'private-snapshot', setups: ['private-setup'] },
      owner: 'private-owner',
      operationId: 'private-operation',
      count: '1001'
    };
    const result = new ModpackError(code, message, { details: privateDetails, retryable }).toPublicResult();

    assert.deepEqual(result, { ok: false, error: { code, message, details: {}, retryable } });
    assert.equal(isValidPublicErrorResult(result), true);
    assert.deepEqual(PUBLIC_ERROR_DETAILS_BY_CODE[code], {});
    for (const [key, value] of Object.entries(privateDetails)) {
      assert.equal(isValidPublicErrorResult({
        ok: false,
        error: { code, message, details: { [key]: value }, retryable }
      }), false, `${code} must reject public ${key} details`);
    }
  });
}

test('MODPACK_SERVICES_UNAVAILABLE explains degraded mode with closed empty details', () => {
  assert.equal(MODPACK_SERVICES_UNAVAILABLE_MESSAGE,
    'Modpack features are turned off because Minecraft Core could not start them. Servers and clients that do not use modpacks keep working.');
  const result = new ModpackError('MODPACK_SERVICES_UNAVAILABLE', MODPACK_SERVICES_UNAVAILABLE_MESSAGE, {
    details: { serverId: 'server-1', path: 'C:\\secret\\server', operationId: 'job-1' },
    cause: new Error('C:\\secret\\ArchiveWorker.exe')
  }).toPublicResult();

  assert.deepEqual(result, {
    ok: false,
    error: { code: 'MODPACK_SERVICES_UNAVAILABLE', message: MODPACK_SERVICES_UNAVAILABLE_MESSAGE, details: {}, retryable: false }
  });
  assert.deepEqual(PUBLIC_ERROR_DETAILS_BY_CODE.MODPACK_SERVICES_UNAVAILABLE, {});
  assert.equal(isValidPublicErrorResult(result), true);
});

test('public error details cannot leak paths or signed URLs', () => {
  const error = new ModpackError('HASH_MISMATCH', 'Integrity check failed', {
    details: { algorithm: 'sha256', path: 'C:\\secret', url: 'https://x/?token=y' }
  });
  assert.deepEqual(error.toPublicResult().error.details, { algorithm: 'sha256' });
});

test('unavailable artifact details refuse paths, URLs, controls and unrecognized status', () => {
  for (const fileName of ['C:\\secret', '../secret', 'https://x/?token=secret', 'secret\nheader', 'secret\x7f']) {
    const result = new ModpackError('ARTIFACT_UNAVAILABLE', 'The published file is unavailable', {
      details: { fileName, httpStatus: '500', path: 'C:\\secret', url: 'https://x/?token=y' }
    }).toPublicResult();
    assert.deepEqual(result.error.details, {});
  }
});

test('server path errors expose only the retryable destination field', () => {
  const result = new ModpackError(
    'SERVER_PATH_TOO_LONG',
    'This server location is too deeply nested for the selected loader on Windows. Choose a shorter folder.',
    {
      details: { field: 'serverPath', path: 'C:\\secret\\server' },
      retryable: true
    }
  ).toPublicResult();

  assert.deepEqual(result.error.details, { field: 'serverPath' });
  assert.equal(result.error.retryable, true);
});

test('public errors only preserve closed safe scalar details for their code', () => {
  const result = new ModpackError('ARCHIVE_LIMIT_EXCEEDED', 'Archive is too large', {
    details: { limit: 'maxArtifactSetBytes', actual: '17179869185', command: '7z x secret.zip', nested: { password: 'nope' } },
    retryable: true,
    cause: new Error('C:\\secret\\archive.zip')
  }).toPublicResult();

  assert.deepEqual(result, {
    ok: false,
    error: {
      code: 'ARCHIVE_LIMIT_EXCEEDED',
      message: 'Archive is too large',
      details: { limit: 'maxArtifactSetBytes', actual: '17179869185' },
      retryable: true
    }
  });
  assert.equal(Object.isFrozen(result), true);
});

test('archive policy exposes only the six exact ratio and reserve limit identifiers', () => {
  const identifiers = [
    'maxPerEntryCompressionRatio',
    'maxAggregateCompressionRatio',
    'minPerEntryRatioExpandedBytes',
    'minAggregateRatioExpandedBytes',
    'minPreflightReserveBytes',
    'preflightReservePercent'
  ];
  for (const limit of identifiers) {
    const result = new ModpackError('ARCHIVE_LIMIT_EXCEEDED', 'Archive policy limit was exceeded', {
      details: { limit, actual: '1001' }
    }).toPublicResult();
    assert.deepEqual(result.error.details, { limit, actual: '1001' });
  }
  const rejected = new ModpackError('ARCHIVE_LIMIT_EXCEEDED', 'Archive policy limit was exceeded', {
    details: { limit: 'customRatioLimit', actual: '1001' }
  }).toPublicResult();
  assert.deepEqual(rejected.error.details, { actual: '1001' });
});

test('public errors drop provider bodies, authorization tokens, archive output, and command-shaped reason values', () => {
  for (const reason of [
    '{"error":"upstream body","token":"secret"}',
    'Authorization: Bearer super-secret-token',
    '7-Zip output: Enter password (secret)',
    'cmd.exe /c 7z x C:\\secret\\archive.rar'
  ]) {
    const result = new ModpackError('MANIFEST_INVALID', 'Manifest could not be read', { details: { reason } }).toPublicResult();
    assert.deepEqual(result.error.details, {}, reason);
  }
});

test('public errors preserve only documented reason-code enums', () => {
  const accepted = new ModpackError('MANIFEST_INVALID', 'Manifest could not be read', {
    details: { reasonCode: 'invalid-json' }
  }).toPublicResult();
  const rejected = new ModpackError('MANIFEST_INVALID', 'Manifest could not be read', {
    details: { reasonCode: 'provider-body' }
  }).toPublicResult();

  assert.deepEqual(accepted.error.details, { reasonCode: 'invalid-json' });
  assert.deepEqual(rejected.error.details, {});
});

test('error construction rejects unapproved codes and unsafe public messages', () => {
  assert.throws(() => new ModpackError('DATABASE_DOWN', 'Database down'), /Unknown modpack failure code/);
  assert.throws(() => new ModpackError('HASH_MISMATCH', 'Read C:\\secret'), /safe message/i);
});

test('a stale review exposes only the closed reason code for server files a running server was using', () => {
  const { validateModpackIpcResult } = require('../../electron/services/modpacks/ipc-schemas.cjs');
  const message = 'Modpack or server files changed or were locked while this review read them. If the server is running, stop it, then review again. Nothing was changed on the server.';
  const result = new ModpackError('PLAN_STALE', message, {
    details: { reasonCode: 'server-files-in-use', field: 'serverSnapshot', path: 'C:\\secret\\server' },
    retryable: true,
    cause: new Error("EBUSY: resource busy or locked, read 'C:\\secret\\server\\config\\pack.json'")
  }).toPublicResult();

  assert.deepEqual(PUBLIC_ERROR_DETAILS_BY_CODE.PLAN_STALE, { reasonCode: ['server-files-in-use'] });
  assert.deepEqual(result, {
    ok: false,
    error: { code: 'PLAN_STALE', message, details: { reasonCode: 'server-files-in-use' }, retryable: true }
  });
  assert.deepEqual(validateModpackIpcResult('modpacks:preflight-management', result), result);
  assert.deepEqual(validateModpackIpcResult('modpacks:preflight', result), result);
  // Every other stale review keeps closed empty details.
  assert.deepEqual(new ModpackError('PLAN_STALE', 'The reviewed server or archive changed', {
    details: { reasonCode: 'content-revision', field: 'contentRevision' }
  }).toPublicResult().error.details, {});
  assert.equal(isValidPublicErrorResult({
    ok: false,
    error: { code: 'PLAN_STALE', message, details: { field: 'serverSnapshot' }, retryable: true }
  }), false);
});
