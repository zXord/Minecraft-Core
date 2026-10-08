import type { RuntimeTuple } from './modpack';

export type ClientPackStatus = 'unmanaged' | 'install-required' | 'unpaired' | 'update-required' | 'modified' | 'ready' | 'runtime-incomplete' | 'recovery-required';
export type ClientCompanionSource =
  | { provider: 'github'; repositoryId: string; githubOwner: string; githubRepo: string; releaseId: string; assetId: string }
  | { provider: 'modrinth'; projectId: string; versionId: string };
export interface ClientCompanionDescriptor {
  schemaVersion: 1;
  status: 'ready' | 'unpaired';
  serverFingerprint: string;
  serverVersion: string;
  source: ClientCompanionSource | null;
  runtime: RuntimeTuple | null;
  artifactSha256: string | null;
}
export interface ClientPackState {
  clientId: string;
  status: ClientPackStatus;
  verified: boolean;
  descriptor: ClientCompanionDescriptor | null;
  recoveryReason?: 'restart-required';
}
export interface ClientPackInstallResult {
  clientId: string;
  status: 'ready' | 'modified';
  verified: boolean;
  cleanup?: {
    status: 'complete' | 'pending' | 'retained';
    completed: string[];
    retained: string[];
    pending: string[];
    forgetPending: string[];
  };
}
export interface ClientPackProgress {
  requestId: string;
  clientId?: string;
  serverId?: string;
  operationId?: string;
  phase: string;
  completedBytes?: string;
  totalBytes?: string;
  completedItems?: string;
  totalItems?: string;
}
export interface ClientPackPreview {
  clientId: string;
  planId: string;
  descriptor: ClientCompanionDescriptor;
  optionalFiles: { id: string; label: string; defaultSelected: true }[];
  optionalFileIds: string[];
  downloadBytes: string;
  additions: string[];
  removals: string[];
  replacements: string[];
  preserved: string[];
  conflicts: { path: string; action: 'replace' | 'remove'; reason: 'modified-owned' | 'unowned'; replaceAllowed: boolean }[];
}
