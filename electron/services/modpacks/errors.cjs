const CLIENT_PACK_SERVER_CHANGED_GUIDANCE = "The server's managed mod files differ from the installed pack. Use Modpack Verify and Repair before installing or launching its matching client pack.";

const FAILURE_CODES = Object.freeze([
  'INVALID_RELEASE_URL', 'RATE_LIMITED', 'REPOSITORY_NOT_FOUND', 'RELEASE_NOT_FOUND', 'ASSET_AMBIGUOUS', 'ASSET_SELECTION_REQUIRED', 'ASSET_CHANGED', 'ARTIFACT_UNAVAILABLE',
  'UNSUPPORTED_ARCHIVE', 'MAGIC_EXTENSION_MISMATCH', 'ENCRYPTED_ARCHIVE', 'MULTIPART_VOLUME_MISSING', 'ARCHIVE_LIMIT_EXCEEDED',
  'UNSAFE_ARCHIVE_ENTRY', 'ARCHIVE_ENTRY_COLLISION', 'EXTRACTOR_UNAVAILABLE', 'EXTRACTOR_FAILED', 'MANIFEST_INVALID', 'CLIENT_ONLY_PACK',
  'MISSING_PROVIDER_DIGEST', 'HASH_MISMATCH', 'PACK_ROOT_AMBIGUOUS', 'LOADER_CONFLICT', 'UNSUPPORTED_LOADER', 'UNSUPPORTED_RUNTIME_LAYOUT',
  'RUNTIME_INCOMPLETE', 'SERVER_PATH_TOO_LONG', 'DOWNGRADE_REQUIRED', 'SWITCH_REQUIRED', 'PLAN_STALE', 'SERVER_RUNNING', 'OPERATION_IN_PROGRESS', 'CANCELLED', 'TARGET_EXISTS', 'INSUFFICIENT_DISK',
  'BACKUP_FAILED', 'COMMIT_FAILED', 'HEALTH_CHECK_FAILED', 'ROLLBACK_FAILED', 'RECOVERY_REQUIRED', 'CLEANUP_FAILED', 'INVALID_REQUEST', 'NO_INSTALLABLE_ASSET', 'CLIENT_PACK_UNAVAILABLE', 'CLIENT_PACK_SERVER_CHANGED', 'CLIENT_RUNNING', 'MANAGED_MOD_EDIT_BLOCKED'
]);

const DETAIL_FIELDS = Object.freeze({
  INVALID_RELEASE_URL: { reasonCode: ['malformed-url', 'non-https', 'credentials-not-allowed', 'host-not-allowed'] },
  RATE_LIMITED: {},
  REPOSITORY_NOT_FOUND: { provider: 'provider', repositoryId: 'id' },
  RELEASE_NOT_FOUND: { provider: 'provider', releaseId: 'id' },
  ASSET_AMBIGUOUS: { count: 'decimal' },
  ASSET_SELECTION_REQUIRED: { count: 'decimal' },
  ASSET_CHANGED: { partId: 'id' },
  ARTIFACT_UNAVAILABLE: { fileName: 'fileName', httpStatus: ['404', '410'] },
  UNSUPPORTED_ARCHIVE: { archiveFamily: 'archiveFamily' },
  MAGIC_EXTENSION_MISMATCH: { archiveFamily: 'archiveFamily' },
  ENCRYPTED_ARCHIVE: {},
  MULTIPART_VOLUME_MISSING: { partId: 'id' },
  ARCHIVE_LIMIT_EXCEEDED: { limit: 'limit', actual: 'decimal' },
  UNSAFE_ARCHIVE_ENTRY: { reasonCode: ['path-traversal', 'link-entry', 'non-regular-entry', 'path-depth', 'path-length'] },
  ARCHIVE_ENTRY_COLLISION: { reasonCode: ['normalized-path-collision', 'file-directory-collision'] },
  EXTRACTOR_UNAVAILABLE: {},
  EXTRACTOR_FAILED: {},
  MANIFEST_INVALID: { reasonCode: ['invalid-json', 'unsupported-format', 'missing-required-field', 'invalid-environment', 'invalid-hash'] },
  CLIENT_ONLY_PACK: {},
  MISSING_PROVIDER_DIGEST: { partId: 'id' },
  HASH_MISMATCH: { algorithm: 'algorithm', expected: 'digest', actual: 'digest' },
  PACK_ROOT_AMBIGUOUS: { count: 'decimal' },
  LOADER_CONFLICT: {},
  UNSUPPORTED_LOADER: { loaderFamily: 'loaderFamily' },
  UNSUPPORTED_RUNTIME_LAYOUT: {},
  RUNTIME_INCOMPLETE: { loaderFamily: 'loaderFamily' },
  SERVER_PATH_TOO_LONG: { field: 'field' },
  DOWNGRADE_REQUIRED: {},
  SWITCH_REQUIRED: {},
  PLAN_STALE: {},
  SERVER_RUNNING: { serverId: 'id' },
  OPERATION_IN_PROGRESS: { operationId: 'id' },
  CANCELLED: {},
  TARGET_EXISTS: {},
  INSUFFICIENT_DISK: { requiredBytes: 'decimal', availableBytes: 'decimal' },
  BACKUP_FAILED: {},
  COMMIT_FAILED: {},
  HEALTH_CHECK_FAILED: {},
  ROLLBACK_FAILED: {},
  RECOVERY_REQUIRED: { operationId: 'id' },
  CLEANUP_FAILED: {},
  INVALID_REQUEST: { field: 'field' },
  NO_INSTALLABLE_ASSET: {},
  CLIENT_PACK_UNAVAILABLE: {},
  CLIENT_PACK_SERVER_CHANGED: {},
  CLIENT_RUNNING: {},
  MANAGED_MOD_EDIT_BLOCKED: {}
});

const PUBLIC_ERROR_DETAILS_BY_CODE = deepFreeze(Object.fromEntries(
  FAILURE_CODES.map((code) => [code, DETAIL_FIELDS[code]])
));

function deepFreeze(value) {
  if (!value || typeof value !== 'object' || Object.isFrozen(value)) return value;
  Object.freeze(value);
  for (const child of Object.values(value)) deepFreeze(child);
  return value;
}

function isSafeText(value) {
  return typeof value === 'string' && value.length > 0 && value.length <= 256 &&
    !/[\\/\u0000-\u001f?]/.test(value) && !/https?:/i.test(value) && !/\b[a-z]:/i.test(value);
}

function isIdentifier(value) {
  return typeof value === 'string' && /^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/.test(value);
}

function isDecimal(value) {
  return typeof value === 'string' && /^(0|[1-9][0-9]*)$/.test(value);
}

function isDigest(value) {
  return typeof value === 'string' && /^(?:[a-f0-9]{40}|[a-f0-9]{64}|[a-f0-9]{128})$/.test(value);
}

function isAllowedDetail(kind, value) {
  if (Array.isArray(kind)) return kind.includes(value);
  switch (kind) {
    case 'id': return isIdentifier(value);
    case 'decimal': return isDecimal(value);
    case 'digest': return isDigest(value);
    case 'algorithm': return value === 'sha1' || value === 'sha256' || value === 'sha512';
    case 'provider': return value === 'modrinth' || value === 'github' || value === 'local';
    case 'archiveFamily': return value === 'mrpack' || value === 'zip' || value === 'rar4' || value === 'rar5' || value === 'multipart-rar';
    case 'loaderFamily': return value === 'vanilla' || value === 'fabric' || value === 'forge' || value === 'neoforge' || value === 'quilt';
    case 'limit': return [
      'maxArtifactSetBytes', 'maxArchiveEntries', 'maxExpandedBytes', 'maxFileExpandedBytes', 'maxPathDepth',
      'maxNormalizedPathLength', 'maxTechnicalStdoutBytes', 'maxTechnicalStderrBytes', 'maxListTestMs', 'maxExtractionMs', 'maxChildJobMemoryBytes',
      'maxPerEntryCompressionRatio', 'maxAggregateCompressionRatio', 'minPerEntryRatioExpandedBytes', 'minAggregateRatioExpandedBytes',
      'minPreflightReserveBytes', 'preflightReservePercent'
    ].includes(value);
    case 'field': return typeof value === 'string' && /^[A-Za-z][A-Za-z0-9.]{0,127}$/.test(value);
    case 'fileName': return isSafeText(value) && !/[\u007f<>:"|*]/.test(value) && value !== '.' && value !== '..';
    default: return false;
  }
}

function publicDetailsFor(code, details) {
  const allowed = PUBLIC_ERROR_DETAILS_BY_CODE[code];
  const source = details && typeof details === 'object' && !Array.isArray(details) ? details : {};
  const result = {};
  for (const [key, kind] of Object.entries(allowed)) {
    if (isAllowedDetail(kind, source[key])) result[key] = source[key];
  }
  return result;
}

function isValidPublicErrorResult(value) {
  if (!value || value.ok !== false || !value.error || typeof value.error !== 'object') return false;
  const { error } = value;
  if (!FAILURE_CODES.includes(error.code) || !isSafeText(error.message) || typeof error.retryable !== 'boolean') return false;
  const details = error.details;
  if (!details || typeof details !== 'object' || Array.isArray(details)) return false;
  const allowed = PUBLIC_ERROR_DETAILS_BY_CODE[error.code];
  return Object.entries(details).every(([key, detail]) => Object.hasOwn(allowed, key) && isAllowedDetail(allowed[key], detail));
}

class ModpackError extends Error {
  constructor(code, safeMessage, { cause, details, retryable = false } = {}) {
    if (!FAILURE_CODES.includes(code)) throw new Error('Unknown modpack failure code');
    if (!isSafeText(safeMessage)) throw new Error('Modpack errors require a safe message');
    if (typeof retryable !== 'boolean') throw new Error('Modpack error retryable must be boolean');
    super(safeMessage, cause === undefined ? undefined : { cause });
    this.name = 'ModpackError';
    this.code = code;
    this.safeMessage = safeMessage;
    this.details = details;
    this.retryable = retryable;
  }

  toPublicResult() {
    const result = {
      ok: false,
      error: {
        code: this.code,
        message: this.safeMessage,
        details: publicDetailsFor(this.code, this.details),
        retryable: this.retryable
      }
    };
    if (!isValidPublicErrorResult(result)) throw new Error('Invalid public modpack error result');
    return deepFreeze(result);
  }
}

module.exports = {
  CLIENT_PACK_SERVER_CHANGED_GUIDANCE,
  FAILURE_CODES,
  ModpackError,
  PUBLIC_ERROR_DETAILS_BY_CODE,
  deepFreeze,
  isValidPublicErrorResult,
  publicDetailsFor
};
