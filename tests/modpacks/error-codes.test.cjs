const test = require('node:test');
const assert = require('node:assert/strict');

const { FAILURE_CODES, ModpackError, PUBLIC_ERROR_DETAILS_BY_CODE } = require('../../electron/services/modpacks/errors.cjs');

const APPROVED_CODES = [
  'INVALID_RELEASE_URL', 'REPOSITORY_NOT_FOUND', 'RELEASE_NOT_FOUND', 'ASSET_AMBIGUOUS', 'ASSET_SELECTION_REQUIRED', 'ASSET_CHANGED',
  'UNSUPPORTED_ARCHIVE', 'MAGIC_EXTENSION_MISMATCH', 'ENCRYPTED_ARCHIVE', 'MULTIPART_VOLUME_MISSING', 'ARCHIVE_LIMIT_EXCEEDED',
  'UNSAFE_ARCHIVE_ENTRY', 'ARCHIVE_ENTRY_COLLISION', 'EXTRACTOR_UNAVAILABLE', 'EXTRACTOR_FAILED', 'MANIFEST_INVALID', 'CLIENT_ONLY_PACK',
  'MISSING_PROVIDER_DIGEST', 'HASH_MISMATCH', 'PACK_ROOT_AMBIGUOUS', 'LOADER_CONFLICT', 'UNSUPPORTED_LOADER', 'UNSUPPORTED_RUNTIME_LAYOUT',
  'RUNTIME_INCOMPLETE', 'PLAN_STALE', 'SERVER_RUNNING', 'OPERATION_IN_PROGRESS', 'CANCELLED', 'TARGET_EXISTS', 'INSUFFICIENT_DISK',
  'BACKUP_FAILED', 'COMMIT_FAILED', 'HEALTH_CHECK_FAILED', 'ROLLBACK_FAILED', 'RECOVERY_REQUIRED', 'CLEANUP_FAILED', 'INVALID_REQUEST', 'NO_INSTALLABLE_ASSET'
];

test('failure code registry contains exactly the approved public and boundary codes', () => {
  assert.deepEqual(FAILURE_CODES, APPROVED_CODES);
  assert.deepEqual(Object.keys(PUBLIC_ERROR_DETAILS_BY_CODE), APPROVED_CODES);
  assert.equal(Object.isFrozen(FAILURE_CODES), true);
  assert.equal(Object.isFrozen(PUBLIC_ERROR_DETAILS_BY_CODE), true);
});

test('public error details cannot leak paths or signed URLs', () => {
  const error = new ModpackError('HASH_MISMATCH', 'Integrity check failed', {
    details: { algorithm: 'sha256', path: 'C:\\secret', url: 'https://x/?token=y' }
  });
  assert.deepEqual(error.toPublicResult().error.details, { algorithm: 'sha256' });
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
