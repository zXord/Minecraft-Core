export type ModpackProvider = 'modrinth' | 'github' | 'local';
export type ModpackFailureCode =
  | 'INVALID_RELEASE_URL' | 'REPOSITORY_NOT_FOUND' | 'RELEASE_NOT_FOUND' | 'ASSET_AMBIGUOUS' | 'ASSET_SELECTION_REQUIRED' | 'ASSET_CHANGED'
  | 'UNSUPPORTED_ARCHIVE' | 'MAGIC_EXTENSION_MISMATCH' | 'ENCRYPTED_ARCHIVE' | 'MULTIPART_VOLUME_MISSING' | 'ARCHIVE_LIMIT_EXCEEDED'
  | 'UNSAFE_ARCHIVE_ENTRY' | 'ARCHIVE_ENTRY_COLLISION' | 'EXTRACTOR_UNAVAILABLE' | 'EXTRACTOR_FAILED' | 'MANIFEST_INVALID' | 'CLIENT_ONLY_PACK'
  | 'MISSING_PROVIDER_DIGEST' | 'HASH_MISMATCH' | 'PACK_ROOT_AMBIGUOUS' | 'LOADER_CONFLICT' | 'UNSUPPORTED_LOADER' | 'UNSUPPORTED_RUNTIME_LAYOUT'
  | 'RUNTIME_INCOMPLETE' | 'PLAN_STALE' | 'SERVER_RUNNING' | 'OPERATION_IN_PROGRESS' | 'CANCELLED' | 'TARGET_EXISTS' | 'INSUFFICIENT_DISK'
  | 'BACKUP_FAILED' | 'COMMIT_FAILED' | 'HEALTH_CHECK_FAILED' | 'ROLLBACK_FAILED' | 'RECOVERY_REQUIRED' | 'CLEANUP_FAILED' | 'INVALID_REQUEST' | 'NO_INSTALLABLE_ASSET';

export interface RuntimeTuple {
  minecraftVersion: string;
  loaderFamily: 'vanilla' | 'fabric' | 'forge' | 'neoforge' | 'quilt';
  loaderVersion: string;
  javaMajor: number;
  os: 'win32';
  architecture: 'x64';
}

export interface PublicModpackErrorResult {
  ok: false;
  error: { code: ModpackFailureCode; message: string; details: Record<string, string>; retryable: boolean };
}
