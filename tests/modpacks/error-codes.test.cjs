const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const ts = require('typescript');

const { FAILURE_CODES, ModpackError, PUBLIC_ERROR_DETAILS_BY_CODE } = require('../../electron/services/modpacks/errors.cjs');

const APPROVED_CODES = [
  'INVALID_RELEASE_URL', 'RATE_LIMITED', 'REPOSITORY_NOT_FOUND', 'RELEASE_NOT_FOUND', 'ASSET_AMBIGUOUS', 'ASSET_SELECTION_REQUIRED', 'ASSET_CHANGED', 'ARTIFACT_UNAVAILABLE',
  'UNSUPPORTED_ARCHIVE', 'MAGIC_EXTENSION_MISMATCH', 'ENCRYPTED_ARCHIVE', 'MULTIPART_VOLUME_MISSING', 'ARCHIVE_LIMIT_EXCEEDED',
  'UNSAFE_ARCHIVE_ENTRY', 'ARCHIVE_ENTRY_COLLISION', 'EXTRACTOR_UNAVAILABLE', 'EXTRACTOR_FAILED', 'MANIFEST_INVALID', 'CLIENT_ONLY_PACK',
  'MISSING_PROVIDER_DIGEST', 'HASH_MISMATCH', 'PACK_ROOT_AMBIGUOUS', 'LOADER_CONFLICT', 'UNSUPPORTED_LOADER', 'UNSUPPORTED_RUNTIME_LAYOUT',
  'RUNTIME_INCOMPLETE', 'SERVER_PATH_TOO_LONG', 'DOWNGRADE_REQUIRED', 'SWITCH_REQUIRED', 'PLAN_STALE', 'SERVER_RUNNING', 'OPERATION_IN_PROGRESS', 'CANCELLED', 'TARGET_EXISTS', 'INSUFFICIENT_DISK',
  'BACKUP_FAILED', 'COMMIT_FAILED', 'HEALTH_CHECK_FAILED', 'ROLLBACK_FAILED', 'RECOVERY_REQUIRED', 'CLEANUP_FAILED', 'INVALID_REQUEST', 'NO_INSTALLABLE_ASSET', 'CLIENT_PACK_UNAVAILABLE', 'CLIENT_PACK_SERVER_CHANGED', 'CLIENT_RUNNING', 'MANAGED_MOD_EDIT_BLOCKED'
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
    'void retryAsDowngrade;',
    'void retryAsSwitch;',
    'void retryAfterRateLimit;',
    'void retryAtShorterPath;',
    'void refuseManagedModEdit;'
  ].join('\n'));
  const program = ts.createProgram([sourcePath], {
    noEmit: true, strict: true, skipLibCheck: true,
    module: ts.ModuleKind.NodeNext, moduleResolution: ts.ModuleResolutionKind.NodeNext,
    target: ts.ScriptTarget.ES2022
  });
  const diagnostics = ts.getPreEmitDiagnostics(program);
  assert.deepEqual(diagnostics.map(diagnostic => ts.flattenDiagnosticMessageText(diagnostic.messageText, '\n')), []);
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
