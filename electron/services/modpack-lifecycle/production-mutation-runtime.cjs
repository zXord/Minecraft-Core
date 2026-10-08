const crypto = require('node:crypto');
const fs = require('node:fs');
const fsp = require('node:fs/promises');
const path = require('node:path');

const { prepareManagedServerRuntime } = require('../loader-install-service.cjs');
const { waitForRuntimeWorkerQuiescence } = require('../runtime-worker-quiescence.cjs');
const { boundedRuntimeSettlement } = require('./server-runtime-writer-authority.cjs');
const {
  isUnprovenHealthProcessError,
  ServerHealthValidator,
  stopValidatedHandoff
} = require('../server-health-validator.cjs');
const {
  DEFAULT_SERVER_HEALTH_TIMEOUT_MS,
  MAX_SERVER_HEALTH_TIMEOUT_MS,
  MAX_SERVER_PROPERTIES_BYTES
} = require('../server-health-constants.cjs');
const { ServerJavaManager } = require('../server-java-manager.cjs');
const {
  issueForgeCandidateHealthAuthorization
} = require('../forge-candidate-health-authorization.cjs');
const { getDefaultServerConfig, readServerConfig } = require('../../utils/config-manager.cjs');
const { applyServerNetworkProperties, isNetworkAccess } = require('../../utils/server-network-properties.cjs');
const instanceContext = require('../../utils/instance-context.cjs');
const { ModpackError, deepFreeze } = require('../modpacks/errors.cjs');
const { computePreflightReserve, parseNonNegativeBytes } = require('../modpacks/limits.cjs');
const { ReleaseTrackingReconciler } = require('../modpacks/notifications/release-tracking-reconciler.cjs');
const { canonicalPath, planOwnership } = require('../modpacks/planning/ownership-planner.cjs');
const {
  reconcileQuiescentOwnership
} = require('../modpacks/planning/quiescent-plan-revalidation.cjs');
const {
  copyRegularFile,
  copyTree,
  scanManifest
} = require('../modpacks/planning/production-candidate-preparer.cjs');
const { assertPlanStillValid } = require('../modpacks/planning/preflight-planner.cjs');
const { computePreflightPlanFingerprint } = require('../modpacks/planning/plan-fingerprint.cjs');
const { createVerifiedRestoreExtractor } = require('./verified-restore-extractor.cjs');
const { RestorePointService } = require('./restore-point-service.cjs');
const { RECORD_SCHEMA_VERSION } = require('./recovery-registry.cjs');
const {
  failureDiagnosticFromError,
  normalizeFailureDiagnostic
} = require('./publication-failure-diagnostic.cjs');
const {
  assertExistingUnmanagedTarget,
  consumeReservedTarget
} = require('./reserved-target-authority.cjs');
const { copyServerDirectoryContents, inspectServerDirectoryTree } = require('./server-directory-identity.cjs');
const {
  buildExistingCandidate,
  buildNewCandidate,
  cleanupCommittedTransaction,
  completeNewLiveValidation,
  createExistingSiblingPaths,
  createSiblingPaths,
  markCommittedHealthy,
  prepareNewLiveValidation,
  publishNewCandidate,
  registerPublishedInstance,
  swapExistingCandidate
} = require('./server-directory-transaction.cjs');

const SOURCE_OPERATION_KINDS = new Set(['install', 'upgrade', 'downgrade', 'switch', 'repair', 'files-only']);
const MANAGEMENT_OPERATION_KINDS = new Set(['detach', 'uninstall', 'rollback-restore-point']);
const FORGE_CONFIRM_PROTECTED_OPERATION_KINDS = new Set([
  'install', 'upgrade', 'downgrade', 'switch', 'repair', 'rollback'
]);
const DURABLE_COMMIT_PHASES = new Set(['committed-healthy', 'cleanup', 'cleanup-pending', 'completed']);
const RUNTIME_ROOTS = new Set(['java', 'libraries', 'versions', '.fabric', '.quilt']);
const RUNTIME_FILES = new Set([
  'server.jar', 'fabric-server-launch.jar', 'quilt-server-launch.jar',
  'quilt-server-launcher.properties', 'user_jvm_args.txt',
  'run.bat', 'run.cmd', 'run.ps1', 'run.sh'
]);
const FORGE_SHIM = /^forge-[A-Za-z0-9._+-]+-[A-Za-z0-9._+-]+-shim\.jar$/i;
const EXCLUDED_MANIFEST_ROOTS = new Set(['backups', 'crash-reports', 'logs']);
const OWNERSHIP_EXCLUDED_ROOTS = new Set(['.minecraft-core-state', 'backups', 'crash-reports', 'logs']);
const SHA256_PATTERN = /^[a-f0-9]{64}$/u;

function invalid(cause) {
  if (cause instanceof ModpackError) return cause;
  return new ModpackError('INVALID_REQUEST', 'The production modpack mutation request is invalid', { cause });
}

function stale(cause) {
  return new ModpackError('PLAN_STALE', 'The reviewed modpack mutation is stale', { cause });
}

function staleDisk(requiredBytes, availableBytes, cause) {
  return new ModpackError('PLAN_STALE', 'Available disk capacity changed after review', {
    cause,
    details: {
      field: 'availableBytes',
      ...(requiredBytes === undefined ? {} : { requiredBytes }),
      ...(availableBytes === undefined ? {} : { availableBytes })
    }
  });
}

function diskBytes(value) {
  try {
    return parseNonNegativeBytes(value);
  } catch (error) {
    throw staleDisk(undefined, undefined, error);
  }
}

function executionServerDisk(value) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw staleDisk();
  return {
    candidateBytes: diskBytes(value.candidateBytes),
    restorePointBytes: diskBytes(value.restorePointBytes),
    rollbackBytes: diskBytes(value.rollbackBytes),
    journalBytes: diskBytes(value.journalBytes)
  };
}

function assertCurrentOperationDiskCapacity({
  availableBytes,
  executionRecord,
  management,
  plan,
  snapshot
}) {
  if (management ? plan?.type !== 'modpack-management-plan' : plan?.type !== 'modpack-preflight-plan') return;
  const available = diskBytes(String(availableBytes));
  const reviewed = executionServerDisk(executionRecord?.reviewedServerDisk);
  const current = executionServerDisk(snapshot);
  const plannedCandidate = diskBytes(plan.disk?.candidateBytes);
  const plannedRestorePoint = diskBytes(plan.disk?.restorePointBytes);
  const plannedRollback = diskBytes(plan.disk?.rollbackBytes);
  const plannedJournal = diskBytes(plan.disk?.journalBytes);
  if (plannedRestorePoint !== reviewed.restorePointBytes || plannedRollback !== reviewed.rollbackBytes ||
      plannedJournal !== reviewed.journalBytes || plannedCandidate < reviewed.candidateBytes) throw staleDisk();

  let baseBytes;
  if (management) {
    if (plannedCandidate !== reviewed.candidateBytes) throw staleDisk();
    let selectedBytes = 0n;
    if (plan.operation.kind === 'rollback-restore-point') {
      const plannedPoint = plan.restorePoints?.[0];
      const selectedPoint = executionRecord.selectedRestorePoint;
      if (!plannedPoint || !selectedPoint || plannedPoint.id !== selectedPoint.id ||
          plannedPoint.sha256 !== selectedPoint.sha256 || plannedPoint.totalBytes !== selectedPoint.totalBytes) {
        throw staleDisk();
      }
      // Extraction produces one owned tree which is promoted into the fresh
      // candidate with a same-volume rename; promotion does not allocate a
      // second copy of the selected payload.
      selectedBytes = diskBytes(selectedPoint.totalBytes);
    } else if (executionRecord.selectedRestorePoint !== null) {
      throw staleDisk();
    }
    baseBytes = current.candidateBytes + current.restorePointBytes + current.rollbackBytes +
      current.journalBytes + selectedBytes;
  } else {
    const staticCandidateBytes = plannedCandidate - reviewed.candidateBytes;
    baseBytes = diskBytes(plan.disk?.downloadBytes) + diskBytes(plan.disk?.expandedBytes) +
      current.candidateBytes + staticCandidateBytes + current.restorePointBytes +
      current.rollbackBytes + current.journalBytes;
  }
  const required = baseBytes + diskBytes(computePreflightReserve(baseBytes.toString()));
  if (available < required) throw staleDisk(required.toString(), available.toString());
}

function exactSourceSnapshot(value, worldDirectories) {
  if (!value || typeof value !== 'object' || Array.isArray(value) ||
      !Array.isArray(value.entries) || typeof value.totalBytes !== 'string' ||
      !Array.isArray(worldDirectories) || worldDirectories.length === 0) throw stale();
  const totalBytes = diskBytes(value.totalBytes);
  const seen = new Set();
  const entries = [];
  let measuredBytes = 0n;
  for (const entry of value.entries) {
    if (!entry || typeof entry !== 'object' || Array.isArray(entry) ||
        !['directory', 'file'].includes(entry.type) ||
        typeof entry.path !== 'string' || typeof entry.pathKey !== 'string' ||
        typeof entry.size !== 'string' || typeof entry.dev !== 'string' ||
        typeof entry.ino !== 'string' || typeof entry.birthtime !== 'string' ||
        !/^\d+$/u.test(entry.dev) || !/^\d+$/u.test(entry.ino) || !/^\d+$/u.test(entry.birthtime)) throw stale();
    const normalized = canonicalPath(entry.path);
    const size = diskBytes(entry.size);
    if (normalized.path !== entry.path || normalized.pathKey !== entry.pathKey || seen.has(entry.pathKey) ||
        (entry.type === 'directory' ? size !== 0n || entry.sha256 !== null : !SHA256_PATTERN.test(entry.sha256))) {
      throw stale();
    }
    seen.add(entry.pathKey);
    if (entry.type === 'file') measuredBytes += size;
    entries.push({
      path: entry.path,
      pathKey: entry.pathKey,
      type: entry.type,
      size: size.toString(),
      sha256: entry.sha256,
      dev: entry.dev,
      ino: entry.ino,
      birthtime: entry.birthtime
    });
  }
  entries.sort((left, right) => left.pathKey.localeCompare(right.pathKey, 'en-US'));
  if (measuredBytes !== totalBytes) throw stale();

  const ownershipEntries = [];
  const pathPreconditions = [];
  const restoreScopeEntries = [];
  let rollbackCarryForwardBytes = 0n;
  for (const entry of entries) {
    const root = entry.pathKey.split('/')[0];
    if (root !== 'backups') {
      const size = Number(entry.size);
      if (!Number.isSafeInteger(size) || size < 0) throw stale();
      restoreScopeEntries.push({
        path: entry.type === 'directory' ? `${entry.path}/` : entry.path,
        type: entry.type,
        size,
        sha256: entry.sha256
      });
    }
    if (entry.type === 'file' &&
        (root === 'backups' || entry.pathKey.startsWith('.minecraft-core-state/history/'))) {
      rollbackCarryForwardBytes += BigInt(entry.size);
    }
    if (entry.pathKey === '.minecraft-core.json' || OWNERSHIP_EXCLUDED_ROOTS.has(root)) continue;
    ownershipEntries.push({
      path: entry.path,
      pathKey: entry.pathKey,
      type: entry.type,
      sha256: entry.sha256,
      size: entry.size,
      origin: 'user'
    });
    pathPreconditions.push({
      path: entry.path,
      pathKey: entry.pathKey,
      exists: true,
      type: entry.type,
      size: entry.size,
      sha256: entry.sha256,
      dev: entry.dev,
      ino: entry.ino,
      birthtime: entry.birthtime
    });
  }
  restoreScopeEntries.sort((left, right) => left.path.localeCompare(right.path, 'en-US'));
  return {
    liveSnapshot: {
      kind: 'existing',
      worldDirectories: [...worldDirectories],
      protectedPaths: [],
      entries: ownershipEntries
    },
    pathPreconditions,
    restoreScopeSha256: crypto.createHash('sha256')
      .update(JSON.stringify(restoreScopeEntries), 'utf8')
      .digest('hex'),
    rollbackCarryForwardBytes,
    totalBytes
  };
}

function assertRemainingExistingDiskCapacity({
  availableBytes,
  executionRecord,
  management,
  plan,
  sourceSnapshot
}) {
  if (management ? plan?.type !== 'modpack-management-plan' : plan?.type !== 'modpack-preflight-plan') return;
  const available = diskBytes(String(availableBytes));
  const reviewed = executionServerDisk(executionRecord?.reviewedServerDisk);
  const plannedCandidate = diskBytes(plan.disk?.candidateBytes);
  const plannedJournal = diskBytes(plan.disk?.journalBytes);
  let baseBytes;
  if (management && plan.operation.kind === 'rollback-restore-point') {
    const plannedPoint = plan.restorePoints?.[0];
    const selectedPoint = executionRecord.selectedRestorePoint;
    if (!plannedPoint || !selectedPoint || plannedPoint.id !== selectedPoint.id ||
        plannedPoint.sha256 !== selectedPoint.sha256 || plannedPoint.totalBytes !== selectedPoint.totalBytes) {
      throw staleDisk();
    }
    baseBytes = diskBytes(selectedPoint.totalBytes) + sourceSnapshot.rollbackCarryForwardBytes + plannedJournal;
  } else {
    let staticCandidateBytes = 0n;
    if (management) {
      if (plannedCandidate !== reviewed.candidateBytes) throw staleDisk();
    } else {
      if (plannedCandidate < reviewed.candidateBytes) throw staleDisk();
      staticCandidateBytes = plannedCandidate - reviewed.candidateBytes;
    }
    baseBytes = sourceSnapshot.totalBytes + staticCandidateBytes + plannedJournal;
  }
  const required = baseBytes + diskBytes(computePreflightReserve(baseBytes.toString()));
  if (available < required) throw staleDisk(required.toString(), available.toString());
}

async function stopRetainedHandoffAfterFailure(handoff, originalError) {
  try {
    await stopValidatedHandoff(handoff);
  } catch (cleanupError) {
    throw new ModpackError(
      'HEALTH_CHECK_FAILED',
      'The validated server process could not be stopped after handoff failed',
      { cause: new AggregateError([originalError, cleanupError], 'Validated server handoff cleanup failed') }
    );
  }
  throw originalError;
}

function isRevision(value, { canIncrement = false } = {}) {
  return Number.isSafeInteger(value) && value >= 0 && (!canIncrement || value < Number.MAX_SAFE_INTEGER);
}

function latestCompletedHistory(entries) {
  if (!Array.isArray(entries)) return null;
  return entries
    .filter(entry => entry?.outcome === 'completed' && Number.isSafeInteger(entry.sequence) && entry.sequence >= 1)
    .sort((left, right) => right.sequence - left.sequence)[0] || null;
}

function readArchivedCoordinatorRevision({ durableFs, fsApi, restoreDirectory }) {
  try {
    const configPath = path.join(restoreDirectory, '.minecraft-core.json');
    const stat = fsApi.lstatSync(configPath, { bigint: true });
    if (!stat.isFile() || stat.isSymbolicLink() || BigInt(stat.nlink) !== 1n) return null;
    const bytes = durableFs.readFileBounded(configPath, { allowMissing: false, maxBytes: 1024 * 1024 });
    const parsed = JSON.parse(bytes.toString('utf8'));
    if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed) ||
        Object.getPrototypeOf(parsed) !== Object.prototype) return null;
    return isRevision(parsed.contentRevision) ? parsed.contentRevision : null;
  } catch {
    return null;
  }
}

function rollbackRevisionChain({ context, linkedHistoryEntries, planned, restored, restoredCoordinatorRevision,
  restoredHistoryEntries, selected }) {
  const restoredRevision = restored?.state?.contentRevision;
  const metadataRevision = selected?.sourceRevision;
  const plannedSourceRevision = planned?.sourceRevision;
  const currentStateRevision = context?.currentState?.state?.contentRevision;
  const currentCoordinatorRevision = context?.plan?.operation?.expectedContentRevision;
  const candidateRevision = context?.candidateState?.contentRevision;
  const latestRestored = latestCompletedHistory(restoredHistoryEntries);
  const latestCurrent = latestCompletedHistory(linkedHistoryEntries);
  const linkedById = Array.isArray(linkedHistoryEntries)
    ? linkedHistoryEntries.filter(entry => entry?.restorePointId === selected?.id)
    : [];
  const linked = linkedById.length === 1 ? linkedById[0] : null;
  const runtimeJson = JSON.stringify(restored?.state?.runtime);
  const linkedSourceMatchesSnapshot = linked?.sourceRevision === restoredRevision ||
    linked?.sourceRevision === metadataRevision;
  const linkedTotalBytesMatches = linked?.restorePointTotalBytes === undefined || selected?.totalBytes === undefined ||
    linked.restorePointTotalBytes === selected.totalBytes;
  const valid = isRevision(restoredRevision) && isRevision(metadataRevision) &&
    isRevision(plannedSourceRevision) && isRevision(restoredCoordinatorRevision) &&
    isRevision(currentStateRevision) && isRevision(currentCoordinatorRevision, { canIncrement: true }) &&
    candidateRevision === currentCoordinatorRevision + 1 && restoredRevision <= metadataRevision &&
    restoredCoordinatorRevision === metadataRevision && latestRestored?.targetRevision === restoredRevision &&
    JSON.stringify(latestRestored?.targetRuntime) === runtimeJson &&
    latestCurrent?.targetRevision === currentStateRevision && linked?.outcome === 'completed' &&
    linked.operationId === selected.operationId && linked.restorePointSha256 === selected.sha256 &&
    linkedTotalBytesMatches && linked.sourceRevision === plannedSourceRevision &&
    linkedSourceMatchesSnapshot && isRevision(linked.targetRevision) && metadataRevision < linked.targetRevision &&
    linked.targetRevision <= currentStateRevision && currentStateRevision <= currentCoordinatorRevision &&
    JSON.stringify(linked.sourceRuntime) === runtimeJson && JSON.stringify(selected.sourceRuntime) === runtimeJson &&
    JSON.stringify(planned.runtime) === runtimeJson;
  return {
    valid,
    evidence: {
      restoredRevision,
      metadataRevision,
      plannedSourceRevision,
      restoredCoordinatorRevision,
      latestRestoredTargetRevision: latestRestored?.targetRevision ?? null,
      latestCurrentTargetRevision: latestCurrent?.targetRevision ?? null,
      linkedSourceRevision: linked?.sourceRevision ?? null,
      linkedTargetRevision: linked?.targetRevision ?? null,
      linkedCount: linkedById.length,
      currentStateRevision,
      currentCoordinatorRevision,
      candidateRevision
    }
  };
}

function runtimeIncomplete(cause) {
  return new ModpackError('RUNTIME_INCOMPLETE', 'The selected modpack runtime could not be prepared', { cause });
}

function samePath(left, right) {
  const a = path.resolve(left);
  const b = path.resolve(right);
  return process.platform === 'win32'
    ? a.toLocaleLowerCase('en-US') === b.toLocaleLowerCase('en-US')
    : a === b;
}

function nowDate(clock) {
  const value = clock();
  const date = value instanceof Date ? new Date(value.getTime()) : new Date(value);
  if (Number.isNaN(date.getTime())) throw invalid();
  return date;
}

async function reportCandidateProgress(onProgress, percent, message, phase = 'staging') {
  if (typeof onProgress !== 'function') return;
  await onProgress(deepFreeze({ phase, percent, message, currentItem: null }));
}

function javaLifecycleProgress(value) {
  const type = value?.type;
  if (type === 'Preparing') return [44, 'Preparing the exact Java runtime'];
  if (type === 'Downloading') {
    const measured = Number.isFinite(value?.progress) ? Math.max(0, Math.min(100, Math.trunc(value.progress))) : 0;
    return [measured >= 50 ? 46 : 45, 'Downloading the exact Java runtime'];
  }
  if (type === 'Extracting') return [46, 'Extracting the exact Java runtime'];
  if (type === 'Verifying') return [47, 'Verifying the exact Java runtime'];
  if (type === 'Complete') return [47, 'Exact Java runtime ready'];
  return null;
}

function createJavaProgressQueue(onProgress) {
  let tail = Promise.resolve();
  let failure = null;
  let lastProgressKey = null;
  return {
    push(value) {
      const mapped = javaLifecycleProgress(value);
      if (!mapped || typeof onProgress !== 'function') return;
      const progressKey = `${mapped[0]}:${mapped[1]}`;
      if (progressKey === lastProgressKey) return;
      lastProgressKey = progressKey;
      tail = tail.then(() => reportCandidateProgress(onProgress, mapped[0], mapped[1]))
        .catch(error => { if (failure === null) failure = error; });
    },
    async drain() {
      await tail;
      if (failure !== null) throw failure;
    }
  };
}

function restoreLifecycleProgress(value) {
  const phase = typeof value?.phase === 'string' ? value.phase : '';
  const processedBytes = Number.isSafeInteger(value?.processedBytes) && value.processedBytes >= 0
    ? value.processedBytes
    : 0;
  const totalBytes = Number.isSafeInteger(value?.totalBytes) && value.totalBytes >= 0 ? value.totalBytes : 0;
  const processedItems = Number.isSafeInteger(value?.processedItems) && value.processedItems >= 0
    ? value.processedItems
    : 0;
  const totalItems = Number.isSafeInteger(value?.totalItems) && value.totalItems >= 0 ? value.totalItems : 0;
  let percent;
  let label;
  let group;
  if (phase === 'source-verification' || phase.startsWith('source-')) {
    [percent, label, group] = [43, 'Verifying the selected restore archive', 0];
  } else if (phase === 'archive-hash') {
    [percent, label, group] = [44, 'Checking the restore archive identity', 1];
  } else if (phase === 'entry-verification') {
    [percent, label, group] = [45, 'Verifying restore archive files', 2];
  } else if (phase === 'extraction') {
    const measured = totalBytes > 0
      ? Math.floor((Math.min(processedBytes, totalBytes) * 2) / totalBytes)
      : (totalItems > 0 ? Math.floor((Math.min(processedItems, totalItems) * 2) / totalItems) : 0);
    [percent, label, group] = [46 + Math.min(2, measured), 'Extracting the verified server snapshot', 3];
  } else if (phase === 'output-verification' || phase.startsWith('final-')) {
    [percent, label, group] = [49, 'Verifying restored server files', 4];
  } else if (phase === 'publication') {
    [percent, label, group] = [49, 'Publishing the restored server snapshot', 5];
  } else if (phase === 'complete') {
    return [49, 'Verified server snapshot restored', 'staging', 6];
  } else {
    return null;
  }
  const details = [];
  if (totalItems > 0) details.push(`${Math.min(processedItems, totalItems)} of ${totalItems} files`);
  if (totalBytes > 0) details.push(`${Math.min(processedBytes, totalBytes)} of ${totalBytes} bytes`);
  return [percent, details.length > 0 ? `${label} (${details.join(', ')})` : label, 'staging', group];
}

function createLatestMappedProgressQueue(onProgress, mapProgress, initialPercent) {
  let active = false;
  let activeGroup = -1;
  let lastAcceptedGroup = -1;
  let failure = null;
  let lastPercent = initialPercent;
  let lastProgressKey = null;
  const pending = [];
  const idleWaiters = [];

  const settleIdleWaiters = () => {
    for (const resolve of idleWaiters.splice(0)) resolve();
  };

  const pump = async () => {
    if (active || failure !== null) return;
    active = true;
    try {
      while (pending.length > 0 && failure === null) {
        const next = pending.shift();
        activeGroup = next.group;
        try {
          await reportCandidateProgress(onProgress, next.percent, next.message, next.phase);
        } catch (error) {
          failure = error;
          pending.splice(0);
        }
      }
    } finally {
      activeGroup = -1;
      active = false;
      settleIdleWaiters();
    }
  };

  return {
    push(value) {
      const mapped = mapProgress(value);
      if (!mapped || typeof onProgress !== 'function') return;
      const group = mapped[3];
      if (!Number.isSafeInteger(group) || group < 0 || group < lastAcceptedGroup || group < activeGroup) return;
      lastAcceptedGroup = Math.max(lastAcceptedGroup, group);
      const percent = Math.max(lastPercent, mapped[0]);
      lastPercent = percent;
      const progressKey = `${group}:${percent}:${mapped[1]}`;
      if (progressKey === lastProgressKey) return;
      lastProgressKey = progressKey;
      const progress = { group, percent, message: mapped[1], phase: mapped[2] || 'staging' };
      const sameGroup = pending.findIndex(item => item.group === group);
      if (sameGroup === -1) pending.push(progress);
      else pending[sameGroup] = progress;
      void pump();
    },
    async drain() {
      while (active || pending.length > 0) {
        await new Promise(resolve => idleWaiters.push(resolve));
      }
      if (failure !== null) throw failure;
    }
  };
}

function createRestoreProgressQueue(onProgress) {
  return createLatestMappedProgressQueue(onProgress, restoreLifecycleProgress, 43);
}

function sha256(value) {
  return crypto.createHash('sha256').update(JSON.stringify(value), 'utf8').digest('hex');
}

function sourceForState(source, artifactSetDigest = null) {
  if (!source || typeof source !== 'object') throw stale();
  const common = { provider: source.provider, version: source.version, title: source.title || 'Modpack' };
  if (source.provider === 'modrinth') {
    return {
      ...common,
      projectId: source.projectId,
      versionId: source.versionId,
      ...(source.channel === undefined ? {} : {
        channel: source.channel,
        prerelease: source.prerelease,
        publishedAt: source.publishedAt
      }),
      ...(artifactSetDigest ? { artifactSetDigest } : {}),
      ...(source.acceptedMapping ? { acceptedMapping: source.acceptedMapping } : {})
    };
  }
  if (source.provider === 'github') {
    return {
      ...common,
      repositoryId: source.repositoryId,
      releaseId: source.releaseId,
      githubOwner: source.githubOwner,
      githubRepo: source.githubRepo,
      ...(source.channel === undefined ? {} : {
        channel: source.channel,
        prerelease: source.prerelease,
        publishedAt: source.publishedAt
      }),
      ...(Array.isArray(source.selectedAssetIds) && source.selectedAssetIds.length > 0
        ? { selectedAssetIds: [...new Set(source.selectedAssetIds)].sort((left, right) => left.localeCompare(right, 'en-US')) }
        : {}),
      ...(artifactSetDigest ? { artifactSetDigest } : {}),
      ...(source.assetPattern ? { assetPattern: source.assetPattern } : {}),
      ...(source.acceptedMapping ? { acceptedMapping: source.acceptedMapping } : {})
    };
  }
  if (source.provider === 'local') {
    return {
      ...common,
      importId: source.importId,
      artifactSha256: source.artifactSha256
    };
  }
  throw stale();
}

function runtimeOwnership(relativePath, runtimePathKeys = null) {
  const key = relativePath.toLocaleLowerCase('en-US');
  const first = key.split('/')[0];
  if (!runtimePathKeys?.has(key) && !RUNTIME_ROOTS.has(first) && !RUNTIME_FILES.has(key) && !FORGE_SHIM.test(relativePath)) {
    return null;
  }
  const role = ['java', 'libraries', 'versions'].includes(first)
    ? 'library'
    : RUNTIME_FILES.has(key) && key.endsWith('.jar')
      ? 'server'
      : 'runtime';
  return { origin: 'runtime', managementPolicy: 'replaceable-managed', role };
}

function isManifestExcluded(pathKey) {
  const first = pathKey.split('/')[0];
  return pathKey === 'eula.txt' || EXCLUDED_MANIFEST_ROOTS.has(first);
}

function candidateManifestFromVerifiedScan({
  verifiedManifest,
  installationId,
  incomingManifest,
  oldManifest = null,
  ownershipPlan = null,
  runtimePathKeys = null
} = {}) {
  const incoming = new Map((incomingManifest?.entries || []).map(entry => [entry.pathKey, entry]));
  const old = new Map((oldManifest?.entries || []).map(entry => [entry.pathKey, entry]));
  const actions = new Map((ownershipPlan?.actions || []).map(entry => [entry.pathKey, entry]));
  const entries = [];
  for (const measured of verifiedManifest.entries) {
    if (isManifestExcluded(measured.pathKey)) continue;
    const runtime = runtimeOwnership(measured.path, runtimePathKeys);
    const incomingEntry = incoming.get(measured.pathKey);
    const oldEntry = old.get(measured.pathKey);
    const action = actions.get(measured.pathKey);
    if (runtime) {
      entries.push({ ...measured, ...runtime, priorBaseline: null });
    } else if (incomingEntry && !['preserve-modified', 'preserve-orphan'].includes(action?.action)) {
      entries.push({
        ...incomingEntry,
        path: measured.path,
        pathKey: measured.pathKey,
        installedHash: measured.installedHash,
        size: measured.size
      });
    } else if (oldEntry && ['unchanged', 'preserve-modified', 'preserve-orphan', 'absent'].includes(action?.action)) {
      const preservedByUser = ['preserve-modified', 'preserve-orphan'].includes(action?.action) ||
        measured.installedHash !== oldEntry.installedHash;
      entries.push({
        ...oldEntry,
        path: measured.path,
        pathKey: measured.pathKey,
        origin: preservedByUser ? 'user' : oldEntry.origin,
        managementPolicy: preservedByUser ? 'protected' : oldEntry.managementPolicy,
        installedHash: measured.installedHash,
        size: measured.size,
        priorBaseline: preservedByUser ? oldEntry.installedHash : oldEntry.priorBaseline
      });
    } else {
      entries.push({
        ...measured,
        origin: 'user',
        managementPolicy: 'protected',
        role: measured.role === 'world' ? 'world' : 'other',
        priorBaseline: null
      });
    }
  }
  entries.sort((left, right) => left.pathKey.localeCompare(right.pathKey, 'en-US'));
  return deepFreeze({ schemaVersion: 1, installationId, entries });
}

async function scanCandidateManifest({
  candidateHashService = null,
  candidatePath,
  installationId,
  incomingManifest,
  oldManifest = null,
  ownershipPlan = null,
  runtimePathKeys = null,
  reparseInspector,
  signal
} = {}) {
  const scanned = await scanManifest(candidatePath, installationId, {
    candidateHashService,
    reparseInspector,
    signal
  });
  return candidateManifestFromVerifiedScan({
    verifiedManifest: scanned.manifest,
    installationId,
    incomingManifest,
    oldManifest,
    ownershipPlan,
    runtimePathKeys
  });
}

function exactIncomingManifest(left, right) {
  if (JSON.stringify(left) !== JSON.stringify(right)) throw stale();
  return left;
}

function samePathPreconditions(left, right) {
  return JSON.stringify(left) === JSON.stringify(right);
}

function snapshotWithReviewedPaths(snapshot, reviewedPaths) {
  return Object.freeze({ ...snapshot, pathPreconditions: reviewedPaths });
}

function operationKindForRecord(plan) {
  if (plan.operation.kind === 'files-only') return 'import';
  if (plan.operation.kind === 'rollback-restore-point') return 'rollback';
  return plan.operation.kind;
}

function transactionOperationKind(operationKind) {
  if (operationKind === 'install-new' || operationKind === 'install-existing') return 'install';
  if (operationKind === 'update') return 'upgrade';
  if (operationKind === 'rollback-restore-point') return 'rollback';
  if (operationKind === 'import-files-only-new') return 'import';
  if (operationKind === 'uninstall-managed') return 'uninstall';
  return operationKind;
}

function historyKind(operationKind) {
  if (operationKind === 'install-new' || operationKind === 'install-existing') return 'install';
  if (operationKind === 'update') return 'upgrade';
  if (operationKind === 'rollback-restore-point') return 'rollback';
  if (operationKind === 'import-files-only-new') return 'import-files-only';
  if (operationKind === 'uninstall-managed') return 'uninstall';
  return operationKind;
}

function defaultRevisionPublisher() {
  const published = new Set();
  return Object.freeze({
    async publishOnce(event) {
      if (published.has(event.eventId)) return { published: true, duplicate: true };
      require('../../utils/event-bus.cjs').emit('server-content-revision-changed', Object.freeze({ ...event }));
      published.add(event.eventId);
      return { published: true, duplicate: false };
    }
  });
}

function defaultYieldControl() {
  return new Promise(resolve => setImmediate(resolve));
}

function defaultDurabilityHandoff() {
  return new Promise(resolve => setImmediate(resolve));
}

function requireAsyncDurability(durableFs) {
  if (!durableFs || typeof durableFs.flushDirectoryAsync !== 'function' ||
      typeof durableFs.renameDurableAsync !== 'function' ||
      typeof durableFs.writeFileAtomicAsync !== 'function') throw invalid();
  return durableFs;
}

class ProductionMutationRuntime {
  constructor({
    availableBytes = null,
    buildExistingCandidateFn = buildExistingCandidate,
    buildNewCandidateFn = buildNewCandidate,
    candidateHashService = null,
    cleanupCommittedTransactionFn = cleanupCommittedTransaction,
    completeNewLiveValidationFn = completeNewLiveValidation,
    clock = () => new Date(),
    assertExistingUnmanagedTargetFn = assertExistingUnmanagedTarget,
    consumeReservedTargetFn = consumeReservedTarget,
    coordinator,
    destinationReservations,
    durabilityHandoff = defaultDurabilityHandoff,
    durableFsFactory,
    fsApi = fs,
    healthTimeoutMs = DEFAULT_SERVER_HEALTH_TIMEOUT_MS,
    healthValidator = null,
    instanceContext: suppliedInstanceContext = instanceContext,
    instanceResolver,
    javaManagerFactory = (serverPath, options) => new ServerJavaManager(serverPath, options),
    markCommittedHealthyFn = markCommittedHealthy,
    planOwnershipFn = planOwnership,
    planValidator = assertPlanStillValid,
    planningAdapter,
    prepareNewLiveValidationFn = prepareNewLiveValidation,
    prepareRuntime = prepareManagedServerRuntime,
    publishNewCandidateFn = publishNewCandidate,
    randomUUID = () => require('node:crypto').randomUUID(),
    recoveryServices,
    registerPublishedInstanceFn = registerPublishedInstance,
    releaseTrackingStore,
    reparseInspector,
    restorePointServiceFactory = null,
    revisionPublisher = null,
    snapshotServer = null,
    stateRepository,
    store,
    swapExistingCandidateFn = swapExistingCandidate,
    userDataPath,
    workspaceRegistry,
    yieldControl = defaultYieldControl
  } = {}) {
    const registry = recoveryServices?.registry;
    const recoveryService = recoveryServices?.recoveryService;
    const runtimePolicy = recoveryServices?.runtimePolicy;
    if (typeof clock !== 'function' ||
        (!healthValidator && !recoveryServices?.healthValidator && !coordinator) || !destinationReservations ||
        typeof destinationReservations.resolve !== 'function' || typeof destinationReservations.consume !== 'function' ||
         typeof destinationReservations.release !== 'function' || typeof planOwnershipFn !== 'function' ||
         typeof durableFsFactory !== 'function' || !fsApi || !instanceResolver ||
         typeof instanceResolver.resolveInstance !== 'function' || typeof planValidator !== 'function' ||
         typeof completeNewLiveValidationFn !== 'function' || typeof prepareNewLiveValidationFn !== 'function' ||
         !planningAdapter || typeof planningAdapter.getExecutionRecord !== 'function' || typeof prepareRuntime !== 'function' ||
        !registry || ['create', 'load', 'transition', 'finish'].some(method => typeof registry[method] !== 'function') ||
        !recoveryService || ['recoverWithLease', 'rollbackWithLease', 'failNewWithLease'].some(method => typeof recoveryService[method] !== 'function') ||
        !runtimePolicy || ['suspend', 'ensureStopped', 'adoptValidatedHandoff', 'restoreAutoRestart'].some(method => typeof runtimePolicy[method] !== 'function') ||
        !releaseTrackingStore || ['list', 'remove', 'upsert'].some(method => typeof releaseTrackingStore[method] !== 'function') ||
        !reparseInspector || typeof reparseInspector.isReparsePoint !== 'function' ||
        !stateRepository || typeof stateRepository.read !== 'function' ||
          typeof stateRepository.appendHistoryAsync !== 'function' ||
          typeof stateRepository.writeCandidateAsync !== 'function' ||
        !store || typeof store.get !== 'function' || typeof userDataPath !== 'string' || !path.isAbsolute(userDataPath) ||
        !workspaceRegistry || typeof workspaceRegistry.resolveOwnedWorkspace !== 'function' ||
         typeof javaManagerFactory !== 'function' || typeof assertExistingUnmanagedTargetFn !== 'function' ||
         typeof consumeReservedTargetFn !== 'function' ||
        (candidateHashService !== null && (!candidateHashService || typeof candidateHashService.hashFile !== 'function' ||
          typeof candidateHashService.dispose !== 'function')) ||
        (restorePointServiceFactory !== null && typeof restorePointServiceFactory !== 'function') ||
        typeof durabilityHandoff !== 'function' || typeof yieldControl !== 'function' ||
        !Number.isSafeInteger(healthTimeoutMs) || healthTimeoutMs < 1 ||
        healthTimeoutMs > MAX_SERVER_HEALTH_TIMEOUT_MS) throw invalid();
    this.availableBytes = availableBytes || (async serverPath => {
      const probe = fsApi.existsSync(serverPath) ? serverPath : path.dirname(serverPath);
      const stat = fsApi.statfsSync(probe, { bigint: true });
      return (BigInt(stat.bavail) * BigInt(stat.bsize)).toString();
    });
    this.buildExistingCandidateFn = buildExistingCandidateFn;
    this.buildNewCandidateFn = buildNewCandidateFn;
    this.candidateHashService = candidateHashService;
    this.cleanupCommittedTransactionFn = cleanupCommittedTransactionFn;
    this.completeNewLiveValidationFn = completeNewLiveValidationFn;
    this.clock = clock;
    this.assertExistingUnmanagedTargetFn = assertExistingUnmanagedTargetFn;
    this.consumeReservedTargetFn = consumeReservedTargetFn;
    this.destinationReservations = destinationReservations;
    this.durabilityHandoff = durabilityHandoff;
    this.durableFsFactory = durableFsFactory;
    this.fs = fsApi;
    this.healthTimeoutMs = healthTimeoutMs;
    this.healthValidator = healthValidator || recoveryServices.healthValidator || new ServerHealthValidator({ coordinator });
    this.instanceContext = suppliedInstanceContext;
    this.instanceResolver = instanceResolver;
    this.javaManagerFactory = javaManagerFactory;
    this.markCommittedHealthyFn = markCommittedHealthyFn;
    this.planOwnership = planOwnershipFn;
    this.planValidator = planValidator;
    this.planningAdapter = planningAdapter;
    this.prepareNewLiveValidationFn = prepareNewLiveValidationFn;
    this.prepareRuntime = prepareRuntime;
    this.publishNewCandidateFn = publishNewCandidateFn;
    this.randomUUID = randomUUID;
    this.recoveryRegistry = registry;
    this.recoveryService = recoveryService;
    this.runtimeWriterAuthority = recoveryServices.runtimeWriterAuthority;
    this.coordinator = coordinator;
    this.registerPublishedInstanceFn = registerPublishedInstanceFn;
    this.releaseTrackingStore = releaseTrackingStore;
    this.releaseTrackingReconciler = recoveryServices.releaseTrackingReconciler || new ReleaseTrackingReconciler({
      trackingStore: releaseTrackingStore,
      recoveryRegistry: registry,
      clock
    });
    this.reparseInspector = reparseInspector;
    this.restorePointServiceFactory = restorePointServiceFactory;
    this.revisionPublisher = revisionPublisher || recoveryServices.revisionPublisher || defaultRevisionPublisher();
    this.runtimePolicy = runtimePolicy;
    this.snapshotServer = snapshotServer || planningAdapter.snapshotServer;
    if (typeof this.snapshotServer !== 'function') throw invalid();
    this.stateRepository = stateRepository;
    this.store = store;
    this.swapExistingCandidateFn = swapExistingCandidateFn;
    this.userDataPath = path.resolve(userDataPath);
    this.workspaceRegistry = workspaceRegistry;
    this.yieldControl = yieldControl;
    this.contexts = new Map();
    this.restartTokens = new Map();
    this.restoredRestartTokens = new WeakMap();
    this.restoreServices = new Map();
  }

  async resolveInstance({ jobId, plan } = {}) {
    if (typeof jobId !== 'string' || plan?.operation?.instanceId === undefined) throw invalid();
    const resolved = await this.instanceResolver.resolveInstance(plan.operation.instanceId);
    if (!resolved || resolved.instanceId !== plan.operation.instanceId || typeof resolved.serverPath !== 'string' ||
        typeof resolved.priorRunning !== 'boolean') throw stale();
    return deepFreeze({
      instanceId: resolved.instanceId,
      serverPath: path.resolve(resolved.serverPath),
      priorRunning: resolved.priorRunning
    });
  }

  async suspendAutoRestart({ jobId, plan, resolved } = {}) {
    if (plan?.operation?.serverKind === 'new') {
      const token = deepFreeze({ held: false, newServer: true, enabled: false, operationId: jobId, serverPath: resolved.serverPath });
      this.restartTokens.set(jobId, token);
      return token;
    }
    const config = readServerConfig(resolved.serverPath, getDefaultServerConfig()) || getDefaultServerConfig();
    const hold = await this.runtimePolicy.suspend({
      instanceId: resolved.instanceId,
      jobId,
      operationId: jobId,
      serverPath: resolved.serverPath
    });
    if (!hold || hold.held !== true) throw invalid();
    const token = deepFreeze({
      ...hold,
      newServer: false,
      enabled: config.autoRestart?.enabled === true,
      operationId: jobId,
      serverPath: resolved.serverPath
    });
    this.restartTokens.set(jobId, token);
    return token;
  }

  async quiesce({ jobId, resolved, restartToken, signal } = {}) {
    if (signal?.aborted) throw new ModpackError('CANCELLED', 'The modpack operation was cancelled');
    const token = restartToken || this.restartTokens.get(jobId);
    if (token?.newServer) return deepFreeze({ alreadyStopped: true });
    return this.runtimePolicy.ensureStopped({
      instanceId: resolved.instanceId,
      jobId,
      operationId: jobId,
      serverPath: resolved.serverPath
    });
  }

  async revalidate({ jobId, plan, choices, selectedRestorePoint, resolved, lease, signal } = {}) {
    const management = plan?.type === 'modpack-management-plan';
    const allowedOperation = management
      ? MANAGEMENT_OPERATION_KINDS.has(plan?.operation?.kind)
      : SOURCE_OPERATION_KINDS.has(plan?.operation?.kind);
    if (!plan?.operation || !allowedOperation || !['new', 'existing'].includes(plan.operation.serverKind) ||
        (management && plan.operation.serverKind !== 'existing') ||
        plan.operation.instanceId !== resolved?.instanceId) throw invalid();
    const expectedPath = plan.operation.serverKind === 'new'
      ? this.destinationReservations.resolve(resolved.instanceId)?.targetPath || resolved.serverPath
      : resolved.serverPath;
    if (!samePath(resolved.serverPath, expectedPath)) throw invalid();
    if (!lease || lease.kind !== 'mutation' || lease.instanceId !== resolved.instanceId ||
        !samePath(lease.serverPath, resolved.serverPath)) throw invalid();
    const executionRecord = this.planningAdapter.getExecutionRecord(plan);
    if (!executionRecord || executionRecord.serverKind !== plan.operation.serverKind ||
        !samePath(executionRecord.serverPath, resolved.serverPath)) throw stale();
    let template = null;
    let expectedTemplateManifest = null;
    if (management) {
      if (executionRecord.operationKind !== plan.operation.kind ||
          typeof executionRecord.execution?.managementOutputId !== 'string') throw stale();
      this.workspaceRegistry.resolveOwnedWorkspace({
        ownerId: jobId,
        id: executionRecord.execution.managementOutputId,
        kind: 'output'
      });
      if (plan.operation.kind === 'rollback-restore-point') {
        const planned = plan.restorePoints?.[0];
        const privatePoint = executionRecord.selectedRestorePoint;
        if (!planned || !privatePoint || privatePoint.id !== planned.id || privatePoint.sha256 !== planned.sha256 ||
            !samePath(privatePoint.serverPath, resolved.serverPath) || selectedRestorePoint?.id !== planned.id ||
            choices?.restorePointId !== planned.id) throw stale();
      } else if (executionRecord.selectedRestorePoint !== null || selectedRestorePoint) {
        throw stale();
      }
    } else {
      if (!executionRecord.incomingManifest || typeof executionRecord.execution?.templateOutputId !== 'string') throw stale();
      template = this.workspaceRegistry.resolveOwnedWorkspace({
        ownerId: jobId,
        id: executionRecord.execution.templateOutputId,
        kind: 'output'
      });
      expectedTemplateManifest = plan.operation.kind === 'repair'
        ? executionRecord.execution.repairPayloadManifest
        : executionRecord.incomingManifest;
      if (!expectedTemplateManifest) throw stale();
      if (plan.operation.serverKind === 'existing') {
        const rescanned = await scanManifest(template.path, expectedTemplateManifest.installationId, {
          candidateHashService: this.candidateHashService,
          reparseInspector: this.reparseInspector,
          signal
        });
        exactIncomingManifest(rescanned.manifest, expectedTemplateManifest);
      }
    }

    const currentState = plan.operation.serverKind === 'existing' ? this.stateRepository.read(resolved.serverPath) : null;
    const adoption = executionRecord.adoption ?? null;
    const unmanagedAdoption = adoption !== null;
    if (unmanagedAdoption) {
      if (management || plan.operation.kind !== 'install' || plan.operation.serverKind !== 'existing' ||
          executionRecord.reservation !== null || currentState?.state?.modpackManaged === true) throw stale();
      await this.assertExistingUnmanagedTargetFn({
        targetPath: resolved.serverPath,
        adoption,
        fsApi: this.fs,
        reparseInspector: this.reparseInspector,
        signal
      });
    }
    const snapshot = await this.snapshotServer({
      currentState,
      expectedContentRevision: plan.operation.expectedContentRevision,
      operationKind: plan.operation.kind,
      runtime: plan.runtime,
      serverKind: plan.operation.serverKind,
      serverPath: resolved.serverPath,
      unmanagedAdoption,
      signal
    });
    const availableBytes = await this.availableBytes(resolved.serverPath);
    const currentContentRevision = plan.operation.serverKind === 'existing' && Number.isSafeInteger(lease?.baseRevision)
      ? lease.baseRevision
      : plan.operation.expectedContentRevision;
    const currentSnapshot = management
      ? {
          contentRevision: currentContentRevision,
          currentState,
          pathPreconditions: snapshot.pathPreconditions,
          restorePoints: snapshot.restorePoints || [],
          availableBytes
        }
      : {
          contentRevision: currentContentRevision,
          pathPreconditions: snapshot.pathPreconditions,
          sourceIdentity: plan.source,
          artifactSetDigest: plan.artifact.setDigest,
          artifactPartsFingerprint: plan.preconditions.artifactPartsFingerprint,
          runtime: plan.runtime,
          inspectionFingerprint: plan.preconditions.inspectionFingerprint,
          ownershipFingerprint: plan.preconditions.ownershipFingerprint,
          selectionsFingerprint: plan.preconditions.selectionsFingerprint,
          restorePointsFingerprint: plan.preconditions.restorePointsFingerprint,
          assetPatternFingerprint: plan.preconditions.assetPatternFingerprint,
          acceptedMappingFingerprint: plan.preconditions.acceptedMappingFingerprint,
          operationFingerprint: plan.preconditions.operationFingerprint,
          availableBytes
        };
    let executionOwnership = plan.ownership;
    let validationSnapshot = currentSnapshot;
    const reviewedPaths = management
      ? plan.preconditions?.pathPreconditions
      : plan.preconditions?.paths;
    if (plan.operation.serverKind === 'existing' && Array.isArray(reviewedPaths) &&
        !samePathPreconditions(snapshot.pathPreconditions, reviewedPaths)) {
      if (management && ['detach', 'rollback-restore-point'].includes(plan.operation.kind)) {
        // These operations either preserve the complete current tree or first
        // capture it in a verified safety point. No reviewed file decision can
        // become more destructive when shutdown itself writes server data.
        validationSnapshot = snapshotWithReviewedPaths(currentSnapshot, reviewedPaths);
      } else {
        let currentOwnership;
        try {
          if (management) {
            const ownershipInput = {
              oldManifest: currentState.manifest,
              liveSnapshot: snapshot.liveSnapshot,
              incomingManifest: { schemaVersion: 1, installationId: 'uninstall-empty', entries: [] }
            };
            const preview = this.planOwnership({ ...ownershipInput, conflictChoices: {} });
            const paths = Object.fromEntries(preview.blocked.map(action => [action.path, { choice: 'keep-mine' }]));
            currentOwnership = this.planOwnership({
              ...ownershipInput,
              conflictChoices: { paths, categories: {} }
            });
          } else {
            currentOwnership = this.planOwnership({
              oldManifest: currentState?.manifest || null,
              liveSnapshot: snapshot.liveSnapshot,
              incomingManifest: expectedTemplateManifest,
              conflictChoices: plan.selections.conflictChoices,
              ...(plan.operation.kind === 'repair' ? { operationKind: 'repair' } : {})
            });
          }
          executionOwnership = reconcileQuiescentOwnership({
            reviewedOwnership: plan.ownership,
            currentOwnership,
            reviewedPathPreconditions: reviewedPaths,
            currentPathPreconditions: snapshot.pathPreconditions,
            worldDirectories: snapshot.liveSnapshot.worldDirectories,
            oldManifest: currentState?.manifest || null,
            incomingManifest: management
              ? { schemaVersion: 1, installationId: 'uninstall-empty', entries: [] }
              : expectedTemplateManifest
          });
        } catch (error) {
          throw error instanceof ModpackError && error.code === 'PLAN_STALE' ? error : stale(error);
        }
        validationSnapshot = snapshotWithReviewedPaths(currentSnapshot, reviewedPaths);
      }
    }
    if (management) {
      this.#assertManagementPlanStillValid(plan, validationSnapshot, { skipAvailableCapacity: true });
    }
    else this.planValidator(plan, validationSnapshot, { skipAvailableCapacity: true });
    if (currentContentRevision !== plan.operation.expectedContentRevision) throw stale();
    assertCurrentOperationDiskCapacity({
      availableBytes,
      executionRecord,
      management,
      plan,
      snapshot
    });

    const targetKind = plan.operation.serverKind;
    const paths = targetKind === 'new'
      ? createSiblingPaths(resolved.serverPath, jobId)
      : createExistingSiblingPaths(resolved.serverPath, jobId);
    const durableFs = requireAsyncDurability(
      this.durableFsFactory([this.userDataPath, path.dirname(resolved.serverPath)])
    );
    const plannedMaxRam = targetKind === 'new' && plan.operation.kind !== 'files-only'
      ? plan.selections?.maxRam
      : null;
    const plannedServerPort = targetKind === 'new' && plan.operation.kind !== 'files-only'
      ? plan.selections?.serverPort
      : null;
    const plannedNetworkAccess = targetKind === 'new' && plan.operation.kind !== 'files-only'
      ? plan.selections?.networkAccess
      : null;
    if (targetKind === 'new' && plan.operation.kind !== 'files-only' &&
        (!Number.isSafeInteger(plannedMaxRam) || plannedMaxRam < 1 || plannedMaxRam > 64 ||
         !Number.isSafeInteger(plannedServerPort) || plannedServerPort < 1025 || plannedServerPort > 65535 ||
         !isNetworkAccess(plannedNetworkAccess))) throw stale();
    const defaults = getDefaultServerConfig(plannedMaxRam === null ? {} : {
      maxRam: plannedMaxRam,
      port: plannedServerPort,
      networkAccess: plannedNetworkAccess
    });
    const config = readServerConfig(resolved.serverPath, defaults) || defaults;
    const priorAutoRestart = this.restartTokens.get(jobId)?.enabled === true;
    const recordOperationKind = operationKindForRecord(plan);
    const timestamp = nowDate(this.clock).toISOString();
    let recoveryRecordCreated = false;
    try {
      await this.recoveryRegistry.create({
      schemaVersion: RECORD_SCHEMA_VERSION,
      sequence: 0,
      jobId,
      operationKind: recordOperationKind,
      target: { kind: targetKind, stableServerId: resolved.instanceId, path: paths.targetPath },
      candidatePath: paths.candidatePath,
      rollbackPath: paths.rollbackPath || null,
      failedPath: paths.failedPath,
      restorePoint: null,
      restoreCreation: null,
      journalPath: null,
      priorRuntime: { running: resolved.priorRunning, autoRestart: priorAutoRestart },
      phase: 'queued',
      swapStep: 'none',
      directoryIdentities: { target: null, candidate: null, rollback: null, failed: null },
      createdAt: timestamp,
      updatedAt: timestamp,
      outcome: null
      });
      recoveryRecordCreated = true;
      await this.#yieldLifecycleControl(signal);
      let existingEvidence = null;
      if (targetKind === 'existing') {
        existingEvidence = await inspectServerDirectoryTree(resolved.serverPath, {
          fsApi: this.fs,
          reparseInspector: this.reparseInspector,
          signal
        });
        await this.#yieldLifecycleControl(signal);
      }
      const uninstallWithoutRuntime = management && plan.operation.kind === 'uninstall' &&
        executionOwnership?.confirmation?.possibleNonRunnable === true;
      const targetRunning = uninstallWithoutRuntime
        ? false
        : management || plan.operation.kind === 'files-only'
          ? resolved.priorRunning
          : resolved.priorRunning || choices.startAfterInstall === true;
      const reservation = targetKind === 'new' ? executionRecord.reservation : null;
      await this.recoveryRegistry.transition(jobId, {
        expectedPhase: 'queued',
        nextPhase: 'preflight',
        patch: {
          directoryIdentities: {
            target: existingEvidence?.directoryIdentity || null,
            candidate: null,
            rollback: null,
            failed: null
          },
          outcome: {
            runtimeWriterProtocol: 1,
            ...(reservation ? { reservation } : {}),
            ...(existingEvidence ? { live: { fingerprint: existingEvidence.fingerprint } } : {}),
            runtime: {
              maxRam: config.maxRam,
              networkAccess: config.networkAccess,
              port: config.port,
              source: currentState?.state?.runtime ?? null,
              target: uninstallWithoutRuntime ? null : plan.runtime
            },
            runtimePolicy: {
              targetRunning,
              targetAutoRestart: uninstallWithoutRuntime ? false : priorAutoRestart,
              targetInactive: uninstallWithoutRuntime
            },
            target: {
              name: targetKind === 'new'
                ? this.destinationReservations.resolve(resolved.instanceId)?.displayName || path.basename(resolved.serverPath)
                : path.basename(resolved.serverPath)
            }
          }
        }
      });
      await this.#yieldLifecycleControl(signal);
      if (targetKind === 'new') {
        const privateReservation = this.destinationReservations.resolve(resolved.instanceId);
        if (!privateReservation || !samePath(privateReservation.targetPath, resolved.serverPath) ||
            JSON.stringify(privateReservation.reservation) !== JSON.stringify(reservation)) throw stale();
        await this.consumeReservedTargetFn({
          targetPath: resolved.serverPath,
          reservation,
          mutationLease: lease,
          durableFs,
          fsApi: this.fs,
          reparseInspector: this.reparseInspector,
          signal
        });
        await this.#yieldLifecycleControl(signal);
      }
      const context = {
        jobId,
        choices,
        config,
        currentSnapshot: validationSnapshot,
        currentState,
        durableFs,
        executionRecord,
        executionOwnership,
        executionPathPreconditions: snapshot.pathPreconditions,
        executionWorldDirectories: snapshot.liveSnapshot.worldDirectories,
        expectedTemplateManifest,
        management,
        paths,
        plan,
        resolved,
        targetRunning,
        templatePath: template?.path || null
      };
      this.contexts.set(jobId, context);
      return deepFreeze({ revalidated: true, targetKind });
    } catch (error) {
      let retainedRecord = null;
      if (!recoveryRecordCreated) {
        try {
          // Registry creation is an authenticated multi-file publication. A
          // rejection can therefore be post-commit; probe the durable record
          // instead of interpreting the rejected promise as proof of absence.
          retainedRecord = await this.recoveryRegistry.load(jobId);
          if (!retainedRecord) {
            if (typeof this.recoveryRegistry.initialize !== 'function') {
              throw new ModpackError(
                'RECOVERY_REQUIRED',
                'The recovery record publication could not be safely reconciled'
              );
            }
            const scan = await this.recoveryRegistry.initialize();
            const shaped = scan && typeof scan === 'object' && Array.isArray(scan.records) &&
              Array.isArray(scan.corrupt) && Array.isArray(scan.blocks) && typeof scan.globalBlock === 'boolean';
            const uncertain = !shaped || scan.globalBlock === true ||
              scan.records.some(item => item?.jobId === jobId) ||
              scan.corrupt.some(item => item?.jobId === jobId) ||
              scan.blocks.some(item => item?.jobId === jobId);
            if (uncertain) {
              throw new ModpackError(
                'RECOVERY_REQUIRED',
                'The recovery record publication could not be safely reconciled'
              );
            }
          }
        } catch (probeError) {
          throw new ModpackError(
            'RECOVERY_REQUIRED',
            'The recovery record publication could not be safely reconciled',
            { cause: new AggregateError([error, probeError], 'Recovery publication probe failed') }
          );
        }
        if (!retainedRecord) {
          try {
            await this.#reconcileUnrecordedFailedRevalidation({
              jobId, plan, resolved, lease, durableFs, executionRecord
            });
          } catch (cleanupError) {
            throw new ModpackError(
              'RECOVERY_REQUIRED',
              'The interrupted modpack revalidation requires recovery',
              { cause: new AggregateError([error, cleanupError], 'Unrecorded revalidation cleanup failed') }
            );
          }
          throw error;
        }
      }
      try {
        await this.#reconcileFailedRevalidation({
          jobId, plan, resolved, lease, durableFs, executionRecord, retainedRecord
        });
      } catch (cleanupError) {
        throw new ModpackError(
          'RECOVERY_REQUIRED',
          'The interrupted modpack revalidation requires recovery',
          { cause: new AggregateError([error, cleanupError], 'Revalidation cleanup failed') }
        );
      }
      throw error;
    }
  }

  async createRestorePoint({ jobId, plan, resolved, signal, onProgress } = {}) {
    const context = this.#context(jobId, plan, resolved);
    const unmanagedAdoption = context.executionRecord.adoption?.kind === 'existing-unmanaged-directory';
    if (plan.operation.serverKind !== 'existing' || (!context.currentState?.state && !unmanagedAdoption)) throw invalid();
    const service = this.#restoreService(resolved.serverPath, context.durableFs);
    const creationRequest = {
      serverPath: resolved.serverPath,
      operationId: jobId,
      sourceRevision: plan.operation.expectedContentRevision,
      sourceRuntime: unmanagedAdoption
        ? context.currentState?.state?.runtime ?? null
        : context.currentState.state.runtime
    };
    const operationOptions = {
      ...(signal ? { signal } : {}),
      ...(typeof onProgress === 'function' ? { onProgress } : {})
    };
    const creationIntent = await service.prepareVerifiedRestorePointCreation(creationRequest, operationOptions);
    await this.recoveryRegistry.transition(jobId, {
      expectedPhase: 'preflight',
      nextPhase: 'snapshotting',
      patch: { restoreCreation: creationIntent }
    });
    const reference = await service.createVerifiedRestorePoint({
      ...creationRequest
    }, {
      creationIntent,
      onCreationState: async restoreCreation => {
        await this.recoveryRegistry.transition(jobId, {
          expectedPhase: 'snapshotting',
          nextPhase: 'snapshotting',
          patch: { restoreCreation }
        });
      },
      ...operationOptions
    });
    const recorded = await this.recoveryRegistry.transition(jobId, {
      expectedPhase: 'snapshotting',
      nextPhase: 'snapshotting',
      patch: { restorePoint: { id: reference.id, sha256: reference.sha256 } }
    });
    context.restorePoint = reference;
    context.forgeCandidateHealthAuthorization = null;
    const operationKind = operationKindForRecord(plan);
    const publishedCreation = recorded?.restoreCreation;
    if (plan.runtime?.loaderFamily === 'forge' &&
        FORGE_CONFIRM_PROTECTED_OPERATION_KINDS.has(operationKind) &&
        recorded?.phase === 'snapshotting' && recorded.restorePoint?.id === reference?.id &&
        recorded.restorePoint?.sha256 === reference?.sha256 &&
        publishedCreation?.schemaVersion === 1 &&
        publishedCreation.kind === 'minecraft-core-lifecycle-restore-creation' &&
        publishedCreation.operationId === jobId && publishedCreation.state === 'published' &&
        publishedCreation.archiveSha256 === reference.sha256 &&
        publishedCreation.sourceRevision === plan.operation.expectedContentRevision) {
      context.forgeCandidateHealthAuthorization = issueForgeCandidateHealthAuthorization({
        candidatePath: context.paths.candidatePath,
        instanceId: resolved.instanceId,
        jobId,
        operationKind,
        restorePointId: reference.id,
        restorePointSha256: reference.sha256,
        runtime: plan.runtime,
        serverPath: resolved.serverPath,
        sourceRevision: plan.operation.expectedContentRevision
      });
    }
    if (signal?.aborted) throw new ModpackError('CANCELLED', 'The modpack operation was cancelled');
    return reference;
  }

  async buildCandidate({ jobId, operationKind, plan, choices, resolved, lease, signal, onProgress } = {}) {
    const context = this.#context(jobId, plan, resolved);
    if (![
      'install-new', 'install-existing', 'update', 'downgrade', 'switch', 'repair',
      'import-files-only-new', 'detach', 'uninstall-managed', 'rollback-restore-point'
    ].includes(operationKind)) {
      throw invalid(new Error(`Unsupported production mutation: ${operationKind}`));
    }
    const filesOnly = operationKind === 'import-files-only-new';
    const management = context.management;
    const candidateState = {
      schemaVersion: 1,
      modpackManaged: !filesOnly,
      source: sourceForState(context.executionRecord.source, plan.artifact?.setDigest || null),
      runtime: plan.runtime,
      selectedOptionalFiles: [...(plan.selections?.optionalFileIds || context.currentState?.state?.selectedOptionalFiles || [])],
      installedAt: context.executionRecord.adoption
        ? nowDate(this.clock).toISOString()
        : context.currentState?.state?.installedAt || nowDate(this.clock).toISOString(),
      contentRevision: plan.operation.expectedContentRevision + 1,
      manifest: management ? context.currentState?.manifest || null : null
    };
    if (operationKind === 'detach') candidateState.modpackManaged = false;
    if (operationKind === 'uninstall-managed') {
      candidateState.modpackManaged = false;
      candidateState.runtime = null;
      candidateState.manifest = null;
    }
    context.candidateState = candidateState;
    const common = this.#transactionContext({
      jobId, operationKind, plan, resolved, lease, signal, onProgress, context, candidateState
    });
    if (plan.operation.serverKind === 'new') {
      const persistCandidateState = filesOnly
        ? ({ candidatePath }) => this.stateRepository.recordFilesOnlyCandidate(candidatePath, {
            operationId: jobId,
            timestamp: nowDate(this.clock).toISOString(),
            contentRevision: candidateState.contentRevision,
            source: sourceForState(context.executionRecord.source, plan.artifact?.setDigest || null),
            provenance: {
              classification: 'files-only',
              inspectionFingerprint: plan.inspection.fingerprint
            }
          })
        : async ({ candidatePath }) => {
            // Seed the private candidate with the reviewed server resources.
            // The state repository then merges its runtime/source summary into
            // the same application-owned configuration before publication.
            await context.durableFs.writeJsonAtomicAsync(
              path.join(candidatePath, '.minecraft-core.json'),
              context.config
            );
            return this.stateRepository.writeCandidateAsync(candidatePath, candidateState);
          };
      return this.buildNewCandidateFn({
        ...common,
        candidatePath: context.paths.candidatePath,
        persistCandidateState,
        // A server pack may persist or derive data from its absolute working
        // directory. Every new managed server is therefore booted exactly once
        // from its final canonical path after publication, never from this
        // private sibling candidate path.
        validateCandidate: false,
        materializeCandidate: async ({ candidatePath }) => {
          if (filesOnly) await this.#materializeFilesOnlyCandidate({ candidatePath, context, signal, onProgress });
          else await this.#materializeNewCandidate({ candidatePath, context, choices, lease, signal, onProgress });
        }
      });
    }
    const uninstall = operationKind === 'uninstall-managed';
    const detach = operationKind === 'detach';
    const rollbackRestore = operationKind === 'rollback-restore-point';
    if (uninstall && !context.restorePoint) throw stale();
    if (detach && !context.restorePoint) throw stale();
    if (rollbackRestore && !context.restorePoint) throw stale();
    return this.buildExistingCandidateFn({
      ...this.#transactionContext({
        jobId,
        operationKind,
        plan,
        resolved,
        lease,
        signal,
        onProgress,
        context,
        candidateState,
        includeCandidateHealthAuthorization: true
      }),
      candidatePath: context.paths.candidatePath,
      ...(rollbackRestore ? { freshCandidate: true } : {}),
      ...(uninstall && context.executionOwnership.confirmation.possibleNonRunnable ? { validateCandidate: false } : {}),
      ...(uninstall ? {
        persistCandidateState: ({ candidatePath }) => this.stateRepository.uninstallCandidate(candidatePath, {
          operationId: jobId,
          timestamp: nowDate(this.clock).toISOString(),
          contentRevision: candidateState.contentRevision,
          confirmation: context.executionOwnership.confirmation,
          restorePointId: context.restorePoint.id,
          restorePointSha256: context.restorePoint.sha256,
          ...(typeof context.restorePoint.totalBytes === 'string'
            ? { restorePointTotalBytes: context.restorePoint.totalBytes }
            : {})
        })
      } : {}),
      ...(detach ? {
        persistCandidateState: ({ candidatePath }) => {
          const detached = this.stateRepository.detachCandidate(candidatePath, {
            operationId: jobId,
            timestamp: nowDate(this.clock).toISOString(),
            contentRevision: candidateState.contentRevision,
            restorePointId: context.restorePoint.id,
            restorePointSha256: context.restorePoint.sha256,
            ...(typeof context.restorePoint.totalBytes === 'string'
              ? { restorePointTotalBytes: context.restorePoint.totalBytes }
              : {})
          });
          return detached?.state ? detached : { state: detached };
        }
      } : {}),
      ...(rollbackRestore ? {
        persistCandidateState: ({ candidatePath }) => this.#persistRollbackCandidateState({
          candidatePath,
          context,
          jobId
        })
      } : {}),
      applyIncoming: async ({ candidatePath }) => {
        if (rollbackRestore) {
          await this.#applyRollbackCandidate({ candidatePath, context, jobId, lease, signal, onProgress });
        }
        else if (!uninstall && operationKind !== 'detach') {
          await this.#applyExistingCandidate({ candidatePath, context, choices, jobId, lease, signal, onProgress });
        }
      }
    });
  }

  async validateCandidate({ jobId, plan, resolved } = {}) {
    this.#context(jobId, plan, resolved);
    return deepFreeze({ validatedByTransaction: true });
  }

  async publishCandidate({ jobId, plan, resolved, lease } = {}) {
    const context = this.#context(jobId, plan, resolved);
    await this.#assertRuntimeRecoveryAllowed(jobId, lease);
    return this.publishNewCandidateFn(this.#transactionContext({
      jobId, operationKind: operationKindForRecord(plan), plan, resolved, lease, signal: undefined, context,
      candidateState: context.candidateState
    }));
  }

  async registerPublishedInstance({ jobId, plan, resolved, lease } = {}) {
    const context = this.#context(jobId, plan, resolved);
    const reservation = this.destinationReservations.resolve(resolved.instanceId);
    if (!reservation || !samePath(reservation.targetPath, resolved.serverPath)) throw stale();
    return this.registerPublishedInstanceFn({
      ...this.#transactionContext({
        jobId, operationKind: operationKindForRecord(plan), plan, resolved, lease, signal: undefined, context,
        candidateState: context.candidateState
      }),
      appStore: this.store,
      instanceContext: this.instanceContext,
      name: reservation.displayName
    });
  }

  async commitCandidate({ jobId, operationKind, plan, resolved, lease } = {}) {
    const context = this.#context(jobId, plan, resolved);
    await this.#assertRuntimeRecoveryAllowed(jobId, lease);
    return this.swapExistingCandidateFn(this.#transactionContext({
      jobId, operationKind, plan, resolved, lease, signal: undefined, context,
      candidateState: context.candidateState
    }));
  }

  async startFinal({ jobId, plan, resolved } = {}) {
    this.#context(jobId, plan, resolved);
    return deepFreeze({ deferredToLiveValidation: true });
  }

  async validateLive({ jobId, operationKind, plan, resolved, running, lease } = {}) {
    const context = this.#context(jobId, plan, resolved);
    await this.#assertRuntimeRecoveryAllowed(jobId, lease);
    context.releaseTrackingIntent ||= this.releaseTrackingReconciler.createIntent({
      serverId: resolved.instanceId,
      operationKind,
      source: context.candidateState.source
    });
    if (plan.operation.serverKind === 'existing') {
      const validation = await this.markCommittedHealthyFn(this.#transactionContext({
        jobId, operationKind, plan, resolved, lease, signal: undefined, context,
        candidateState: context.candidateState,
        ...(operationKind === 'uninstall-managed' && context.executionOwnership.confirmation.possibleNonRunnable
          ? { validateLive: false }
          : {})
      }));
      return validation;
    }
    let record = await this.recoveryRegistry.load(jobId);
    if (!record || record.phase !== 'registering' || record.outcome?.registration?.complete !== true) throw invalid();
    const filesOnly = operationKind === 'import-files-only-new';
    if (filesOnly && running === true) throw invalid();
    const transactionContext = this.#transactionContext({
      jobId, operationKind, plan, resolved, lease, signal: undefined, context,
      candidateState: context.candidateState
    });
    let liveValidationAuthorization = null;
    let validation;
    let commitPhase;
    let adopted = false;
    try {
      if (filesOnly) {
        record = await this.recoveryRegistry.transition(jobId, {
          expectedPhase: 'registering', nextPhase: 'validating-live', patch: {}
        });
        validation = deepFreeze({ skipped: true, reason: 'files-only' });
        commitPhase = 'validating-live';
      } else {
        liveValidationAuthorization = await this.prepareNewLiveValidationFn(transactionContext);
        record = await this.recoveryRegistry.load(jobId);
        if (!record || record.phase !== 'validating-live') throw invalid();
        validation = await this.healthValidator.validateLive({
          captureBootDiagnostic: true,
          instanceId: resolved.instanceId,
          jobId,
          keepRunning: running === true,
          maxRam: context.config.maxRam,
          mutationLease: lease,
          networkAccess: context.config.networkAccess,
          port: context.config.port,
          runtime: plan.runtime,
          serverPath: resolved.serverPath,
          timeoutMs: this.healthTimeoutMs
        });
        await this.completeNewLiveValidationFn(transactionContext, liveValidationAuthorization);
        record = await this.recoveryRegistry.load(jobId);
        if (!record || record.phase !== 'validating-live') throw invalid();
        commitPhase = 'validating-live';
      }
      if (!filesOnly && running === true) {
        const adoptionFailure = () => new ModpackError(
          'HEALTH_CHECK_FAILED',
          'The validated server process could not be adopted'
        );
        if (!validation?.handoff) throw adoptionFailure();
        const result = await this.runtimePolicy.adoptValidatedHandoff({
          eventId: `modpack-runtime-handoff:${jobId}`,
          handoff: validation.handoff,
          instanceId: resolved.instanceId,
          jobId,
          serverPath: resolved.serverPath
        });
        adopted = result?.adopted === true;
        if (!adopted) throw adoptionFailure();
      }
    } catch (error) {
      if (validation?.handoff && !adopted) {
        await stopRetainedHandoffAfterFailure(validation.handoff, error);
      }
      throw error;
    }
    const event = {
      eventId: `modpack-content-revision:${jobId}:${context.candidateState.contentRevision}`,
      instanceId: resolved.instanceId,
      operationKind: transactionOperationKind(operationKind),
      targetRevision: context.candidateState.contentRevision
    };
    record = await this.recoveryRegistry.transition(jobId, {
      expectedPhase: commitPhase,
      nextPhase: 'committed-healthy',
      patch: {
        outcome: {
          ...(record.outcome || {}),
          health: validation?.evidence || validation || { ok: true },
          runtimePolicy: {
            ...(record.outcome?.runtimePolicy || {}),
            handoffEventId: !filesOnly && running ? `modpack-runtime-handoff:${jobId}` : null,
            runningRestored: adopted
          },
          revisionEvent: { eventId: event.eventId, published: false },
          releaseTracking: context.releaseTrackingIntent
        }
      }
    });
    await this.revisionPublisher.publishOnce(event);
    await this.recoveryRegistry.transition(jobId, {
      expectedPhase: 'committed-healthy',
      nextPhase: 'committed-healthy',
      patch: {
        outcome: {
          ...record.outcome,
          revisionEvent: { eventId: event.eventId, published: true }
        }
      }
    });
    return validation;
  }

  async isDurablyCommitted({ jobId, plan, resolved } = {}) {
    this.#context(jobId, plan, resolved);
    const record = await this.recoveryRegistry.load(jobId);
    return Boolean(
      record && record.jobId === jobId && DURABLE_COMMIT_PHASES.has(record.phase) &&
      record.target?.stableServerId === resolved.instanceId && samePath(record.target.path, resolved.serverPath)
    );
  }

  async persistOutcome({ jobId, operationKind, plan, restorePoint, resolved } = {}) {
    const context = this.#context(jobId, plan, resolved);
    const stateRepositoryOwnsHistory = [
      'detach', 'uninstall-managed', 'import-files-only-new', 'rollback-restore-point'
    ].includes(operationKind);
    const effectiveRestorePoint = restorePoint || context.restorePoint || null;
    const existing = this.stateRepository.listHistory(resolved.serverPath, { cursor: null, limit: 200 });
    const ownedHistory = (existing?.items || []).find(entry => entry.operationId === jobId);
    const sequence = ownedHistory?.sequence || Math.max(0, ...(existing?.items || []).map(entry => entry.sequence || 0)) + 1;
    const history = {
      schemaVersion: 1,
      operationId: jobId,
      sequence,
      kind: historyKind(operationKind),
      outcome: 'completed',
      timestamp: nowDate(this.clock).toISOString(),
      sourceRevision: plan.operation.expectedContentRevision,
      targetRevision: context.candidateState.contentRevision,
      ...(context.currentState?.state?.runtime ? { sourceRuntime: context.currentState.state.runtime } : {}),
      ...(plan.runtime ? { targetRuntime: plan.runtime } : {}),
      ...(effectiveRestorePoint?.id
        ? {
            restorePointId: effectiveRestorePoint.id,
            restorePointSha256: effectiveRestorePoint.sha256,
            ...(typeof effectiveRestorePoint.totalBytes === 'string'
              ? { restorePointTotalBytes: effectiveRestorePoint.totalBytes }
              : {})
          }
        : {})
    };
    if (!stateRepositoryOwnsHistory) {
      await this.stateRepository.appendHistoryAsync(resolved.serverPath, history);
      await this.yieldControl();
    }
    context.releaseTrackingIntent ||= this.releaseTrackingReconciler.createIntent({
      serverId: resolved.instanceId,
      operationKind,
      source: context.candidateState.source
    });
    await this.releaseTrackingReconciler.persistIntent(jobId, context.releaseTrackingIntent);
    await this.yieldControl();
    await this.releaseTrackingReconciler.reconcile(jobId);
    await this.yieldControl();
    return deepFreeze({ historySequence: sequence });
  }

  async cleanup({ jobId, operationKind, plan, resolved, lease } = {}) {
    const context = this.#context(jobId, plan, resolved);
    await this.#assertRuntimeRecoveryAllowed(jobId, lease);
    await this.releaseTrackingReconciler.reconcile(jobId);
    await this.yieldControl();
    if (plan.operation.serverKind === 'existing') {
      const cleanup = await this.cleanupCommittedTransactionFn(this.#transactionContext({
        jobId, operationKind, plan, resolved, lease, signal: undefined, context,
        candidateState: context.candidateState
      }));
      if (cleanup?.phase !== 'completed' || cleanup.rollbackRemoved !== true) {
        throw new ModpackError('RECOVERY_REQUIRED', 'The committed server cleanup is still pending');
      }
      await this.yieldControl();
    }
    const record = await this.recoveryRegistry.load(jobId);
    if (record) {
      await this.recoveryRegistry.finish(jobId, {
        terminalPhase: 'completed',
        outcome: record.outcome || { result: 'completed' }
      });
      await this.yieldControl();
    }
    if (plan.operation.serverKind === 'new') this.destinationReservations.consume(resolved.instanceId, resolved.serverPath);
    this.contexts.delete(jobId);
    this.restartTokens.delete(jobId);
    return deepFreeze({ cleaned: true });
  }

  async rollback({ jobId, plan, resolved, lease, error } = {}) {
    this.#context(jobId, plan, resolved);
    if (isUnprovenHealthProcessError(error)) {
      throw new ModpackError(
        'RECOVERY_REQUIRED',
        'The exact server process must be proven stopped before recovery can continue',
        { cause: error }
      );
    }
    const record = await this.recoveryRegistry.load(jobId);
    if (!record) throw invalid();
    const beforeExistingSwap = plan.operation.serverKind === 'existing' && (
      ['queued', 'preflight', 'snapshotting', 'staging', 'validating-candidate'].includes(record.phase) ||
      (record.phase === 'committing' && ['none', 'prepared'].includes(record.swapStep))
    );
    const result = plan.operation.serverKind === 'new'
      ? this.recoveryService.failNewWithLease(record, lease, error)
      : beforeExistingSwap
        ? this.recoveryService.recoverWithLease(record, lease)
        : this.recoveryService.rollbackWithLease(record, lease, error?.code || 'lifecycle-rollback');
    const recovered = await result;
    if (plan.operation.serverKind === 'new') this.#releaseReservation(resolved);
    this.contexts.delete(jobId);
    return recovered;
  }

  async abandonCandidate({ jobId, plan, resolved, lease, error } = {}) {
    this.#context(jobId, plan, resolved);
    let record = await this.recoveryRegistry.load(jobId);
    if (!record) return deepFreeze({ alreadyAbsent: true });
    const failure = failureDiagnosticFromError(error);
    const storedFailure = normalizeFailureDiagnostic(record.outcome?.failure);
    if (failure && !storedFailure) {
      record = await this.recoveryRegistry.transition(jobId, {
        expectedPhase: record.phase,
        nextPhase: record.phase,
        patch: {
          outcome: {
            ...(record.outcome || {}),
            failure
          }
        }
      });
    }
    await this.#assertRuntimeRecoveryAllowed(jobId, lease);
    try { await boundedRuntimeSettlement(waitForRuntimeWorkerQuiescence(error), 5000, error); }
    catch (closureError) {
      this.coordinator?.quarantineMutation(lease);
      throw closureError;
    }
    const recovered = await this.recoveryService.recoverWithLease(record, lease);
    if (plan.operation.serverKind === 'new') this.#releaseReservation(resolved);
    this.contexts.delete(jobId);
    return recovered;
  }

  async restorePriorState({ jobId, plan, resolved, restartToken } = {}) {
    const token = restartToken || this.restartTokens.get(jobId);
    if (!token || token.newServer) {
      this.restartTokens.delete(jobId);
      return deepFreeze({ restored: true, newServer: true });
    }
    if (this.restoredRestartTokens.has(token)) return this.restoredRestartTokens.get(token);
    const keepDisabled = plan?.operation?.kind === 'uninstall' &&
      plan.ownership?.confirmation?.possibleNonRunnable === true;
    const restored = await this.runtimePolicy.restoreAutoRestart({
      enabled: keepDisabled ? false : token.enabled,
      operationId: token.operationId,
      serverPath: resolved.serverPath
    });
    this.restoredRestartTokens.set(token, restored);
    this.restartTokens.delete(jobId);
    return restored;
  }

  #assertManagementPlanStillValid(plan, snapshot, { skipAvailableCapacity = false } = {}) {
    if (!plan || plan.type !== 'modpack-management-plan' || plan.schemaVersion !== 1 ||
        computePreflightPlanFingerprint(plan) !== plan.fingerprint || !snapshot.currentState?.state ||
        snapshot.contentRevision !== plan.operation.expectedContentRevision ||
        sha256(snapshot.currentState) !== plan.preconditions?.stateFingerprint ||
        JSON.stringify(snapshot.pathPreconditions) !== JSON.stringify(plan.preconditions?.pathPreconditions) ||
        sha256(snapshot.pathPreconditions) !== plan.preconditions?.pathPreconditionsFingerprint ||
        sha256(plan.ownership) !== plan.preconditions?.ownershipFingerprint ||
        sha256(plan.restorePoints) !== plan.preconditions?.restorePointsFingerprint ||
        sha256(plan.operation) !== plan.preconditions?.operationFingerprint) throw stale();
    for (const expected of plan.restorePoints || []) {
      const current = snapshot.restorePoints.find(point => point?.id === expected.id);
      if (!current || current.sha256 !== expected.sha256 || current.sourceRevision !== expected.sourceRevision ||
          current.worldIncluded !== expected.worldIncluded || JSON.stringify(current.runtime) !== JSON.stringify(expected.runtime)) {
        throw stale();
      }
    }
    try {
      if (!skipAvailableCapacity &&
          BigInt(snapshot.availableBytes) < BigInt(plan.preconditions.minimumAvailableBytes)) throw stale();
    } catch (error) {
      throw error instanceof ModpackError ? error : stale(error);
    }
    return plan;
  }

  async #reconcileFailedRevalidation({
    jobId, plan, resolved, lease, durableFs, executionRecord, retainedRecord = null
  }) {
    const record = retainedRecord || await this.recoveryRegistry.load(jobId);
    if (record) {
      if (record.phase === 'queued') {
        // No server content can have changed before the queued record advances.
        // A new-server reservation may still be an app-owned empty directory,
        // so consume that exact reservation before closing the recovery record.
        if (plan.operation.serverKind === 'new') {
          await this.consumeReservedTargetFn({
            targetPath: resolved.serverPath,
            reservation: executionRecord.reservation,
            mutationLease: lease,
            durableFs,
            fsApi: this.fs,
            reparseInspector: this.reparseInspector
          });
        }
        await this.recoveryRegistry.finish(jobId, {
          terminalPhase: 'failed',
          outcome: { recovery: { action: 'revalidation-aborted' } }
        });
      } else {
        await this.recoveryService.recoverWithLease(record, lease);
      }
    }
    if (plan.operation.serverKind === 'new') this.#releaseReservation(resolved);
    this.contexts.delete(jobId);
  }

  async #reconcileUnrecordedFailedRevalidation({ jobId, plan, resolved, lease, durableFs, executionRecord }) {
    if (plan.operation.serverKind === 'new') {
      await this.consumeReservedTargetFn({
        targetPath: resolved.serverPath,
        reservation: executionRecord.reservation,
        mutationLease: lease,
        durableFs,
        fsApi: this.fs,
        reparseInspector: this.reparseInspector
      });
      this.#releaseReservation(resolved);
    }
    this.contexts.delete(jobId);
  }

  #releaseReservation(resolved) {
    const released = this.destinationReservations.release(resolved.instanceId);
    if (released !== true) throw new ModpackError(
      'RECOVERY_REQUIRED',
      'The failed server destination reservation could not be released'
    );
  }

  #context(jobId, plan, resolved) {
    const context = this.contexts.get(jobId);
    if (!context || context.plan !== plan || context.resolved.instanceId !== resolved.instanceId ||
        !samePath(context.resolved.serverPath, resolved.serverPath)) throw stale();
    return context;
  }

  async #assertRuntimeRecoveryAllowed(jobId, lease) {
    const record = await this.recoveryRegistry.load(jobId);
    if (!record) return;
    if (typeof this.runtimeWriterAuthority?.assertRecoveryAllowed !== 'function') {
      throw new ModpackError('RECOVERY_REQUIRED', 'Runtime recovery authority is unavailable');
    }
    await this.runtimeWriterAuthority.assertRecoveryAllowed(record, { lease });
  }

  async #withRuntimeWriters(context, lease, work) {
    if (typeof this.runtimeWriterAuthority?.run !== 'function') {
      throw new ModpackError('RECOVERY_REQUIRED', 'Runtime writer authority is unavailable');
    }
    return this.runtimeWriterAuthority.run(context.jobId, work, { lease });
  }

  async #yieldLifecycleControl(signal) {
    await this.durabilityHandoff();
    if (signal?.aborted) throw new ModpackError('CANCELLED', 'The modpack operation was cancelled');
  }

  async #authorizeSourceSnapshot({ context, plan, resolved, sourceSnapshot }) {
    const current = exactSourceSnapshot(sourceSnapshot, context.executionWorldDirectories);
    let authorizedOwnership = context.executionOwnership;
    if (context.management && plan.operation.kind === 'rollback-restore-point') {
      if (!context.restorePoint?.scopeSha256 ||
          current.restoreScopeSha256 !== context.restorePoint.scopeSha256) throw stale();
    } else if (!(context.management && plan.operation.kind === 'detach')) {
      const oldManifest = context.currentState?.manifest || null;
      const incomingManifest = context.management
        ? { schemaVersion: 1, installationId: 'uninstall-empty', entries: [] }
        : context.expectedTemplateManifest;
      if (!incomingManifest) throw stale();
      let currentOwnership;
      try {
        const ownershipInput = {
          oldManifest,
          liveSnapshot: current.liveSnapshot,
          incomingManifest
        };
        if (context.management) {
          const preview = this.planOwnership({ ...ownershipInput, conflictChoices: {} });
          const paths = Object.fromEntries(preview.blocked.map(action => [action.path, { choice: 'keep-mine' }]));
          currentOwnership = this.planOwnership({
            ...ownershipInput,
            conflictChoices: { paths, categories: {} }
          });
        } else {
          currentOwnership = this.planOwnership({
            ...ownershipInput,
            conflictChoices: plan.selections.conflictChoices,
            ...(plan.operation.kind === 'repair' ? { operationKind: 'repair' } : {})
          });
        }
        authorizedOwnership = reconcileQuiescentOwnership({
          reviewedOwnership: context.executionOwnership,
          currentOwnership,
          reviewedPathPreconditions: context.executionPathPreconditions,
          currentPathPreconditions: current.pathPreconditions,
          worldDirectories: context.executionWorldDirectories,
          oldManifest,
          incomingManifest
        });
      } catch (error) {
        throw error instanceof ModpackError && error.code === 'PLAN_STALE' ? error : stale(error);
      }
    }
    const availableBytes = await this.availableBytes(resolved.serverPath);
    assertRemainingExistingDiskCapacity({
      availableBytes,
      executionRecord: context.executionRecord,
      management: context.management,
      plan,
      sourceSnapshot: current
    });
    context.executionOwnership = authorizedOwnership;
    context.executionPathPreconditions = current.pathPreconditions;
    return deepFreeze({ authorized: true });
  }

  #transactionContext({
    jobId,
    operationKind,
    plan,
    resolved,
    lease,
    signal,
    onProgress,
    context,
    candidateState,
    validateLive,
    includeCandidateHealthAuthorization = false
  }) {
    return {
      jobId,
      operationKind: transactionOperationKind(operationKind),
      stableInstanceId: resolved.instanceId,
      targetPath: resolved.serverPath,
      fsApi: this.fs,
      durableFs: context.durableFs,
      recoveryRegistry: this.recoveryRegistry,
      mutationLease: lease,
      reparseInspector: this.reparseInspector,
      plan,
      currentSnapshot: context.currentSnapshot,
      unmanagedAdoption: context.executionRecord.adoption?.kind === 'existing-unmanaged-directory',
      stateRepository: this.stateRepository,
      planValidator: context.management
        ? (managementPlan, snapshot) => this.#assertManagementPlanStillValid(
            managementPlan,
            snapshot,
            { skipAvailableCapacity: true }
          )
        : (sourcePlan, snapshot) => this.planValidator(
            sourcePlan,
            snapshot,
            { skipAvailableCapacity: true }
          ),
      ...(plan.operation.serverKind === 'existing' ? {
        authorizeSourceSnapshot: sourceSnapshot => this.#authorizeSourceSnapshot({
          context,
          plan,
          resolved,
          sourceSnapshot
        })
      } : {}),
      candidateState,
      ...(includeCandidateHealthAuthorization === true && context.forgeCandidateHealthAuthorization
        ? { forgeCandidateHealthAuthorization: context.forgeCandidateHealthAuthorization }
        : {}),
      ...(validateLive === undefined ? {} : { validateLive }),
      healthValidator: this.healthValidator,
      runtime: plan.runtime,
      maxRam: context.config.maxRam,
      networkAccess: context.config.networkAccess,
      port: context.config.port,
      healthTimeoutMs: this.healthTimeoutMs,
      signal,
      ...(typeof onProgress === 'function' ? { onProgress } : {}),
      runtimePolicy: this.runtimePolicy,
      revisionPublisher: this.revisionPublisher,
      ...(context.releaseTrackingIntent ? { releaseTrackingIntent: context.releaseTrackingIntent } : {}),
      clock: this.clock,
      durabilityHandoff: this.durabilityHandoff,
      yieldControl: this.yieldControl
    };
  }

  async #materializeFilesOnlyCandidate({ candidatePath, context, signal, onProgress }) {
    await this.#copyReviewedTemplate(candidatePath, context, signal, {
      label: 'reviewed archive files',
      onProgress
    });
  }

  async #applyRollbackCandidate({ candidatePath, context, jobId, lease, signal, onProgress }) {
    const selected = context.executionRecord.selectedRestorePoint;
    const planned = context.plan.restorePoints?.[0];
    if (!selected || selected.id !== planned?.id || selected.sha256 !== planned.sha256) throw stale();
    const service = this.#restoreService(context.resolved.serverPath, context.durableFs);
    if (typeof service.restoreToOwnedCandidate !== 'function') throw invalid();
    const operationWorkspace = path.join(candidatePath, '.minecraft-core-state', 'operations', jobId);
    const restoreDirectory = path.join(operationWorkspace, 'selected-restore');
    await reportCandidateProgress(onProgress, 43, 'Restoring the selected verified server snapshot');
    const restoreProgress = createRestoreProgressQueue(onProgress);
    await service.restoreToOwnedCandidate(selected, restoreDirectory, candidatePath, {
      signal,
      onProgress: value => restoreProgress.push(value)
    });
    await restoreProgress.drain();
    const restored = this.stateRepository.read(restoreDirectory);
    if (!restored?.state || restored.state.modpackManaged !== true || !restored.manifest ||
        JSON.stringify(restored.state.runtime) !== JSON.stringify(context.plan.runtime)) throw stale();
    let revisionChain;
    try {
      const restoredHistory = this.stateRepository.listHistory(restoreDirectory, { cursor: null, limit: 200 });
      const linkedHistory = this.stateRepository.listHistory(context.resolved.serverPath, { cursor: null, limit: 200 });
      revisionChain = rollbackRevisionChain({
        context,
        linkedHistoryEntries: linkedHistory?.items,
        planned,
        restored,
        restoredCoordinatorRevision: readArchivedCoordinatorRevision({
          durableFs: context.durableFs,
          fsApi: this.fs,
          restoreDirectory
        }),
        restoredHistoryEntries: restoredHistory?.items,
        selected
      });
    } catch (error) {
      throw stale(error);
    }
    if (!revisionChain.valid) throw stale();

    const preservedNames = new Set(['.minecraft-core-state', 'backups']);
    for (const name of this.fs.readdirSync(candidatePath)) {
      if (preservedNames.has(name.toLocaleLowerCase('en-US'))) continue;
      await this.#removeControlledEntry(path.join(candidatePath, name), candidatePath, signal);
      lease.markDirty();
    }
    for (const entry of this.fs.readdirSync(restoreDirectory, { withFileTypes: true })) {
      if (['.minecraft-core-state', 'backups'].includes(entry.name.toLocaleLowerCase('en-US'))) continue;
      const source = path.join(restoreDirectory, entry.name);
      const destination = path.join(candidatePath, entry.name);
      const stat = this.fs.lstatSync(source, { bigint: true });
      const reparse = await this.reparseInspector.isReparsePoint(source, signal ? { signal } : undefined);
      const invalidEntry = this.fs.existsSync(destination) || entry.isSymbolicLink() || stat.isSymbolicLink() ||
        reparse !== false || (!stat.isDirectory() && (!stat.isFile() || BigInt(stat.nlink) !== 1n));
      if (invalidEntry) throw stale();
      await context.durableFs.renameDurableAsync(source, destination);
      lease.markDirty();
    }

    const restoredRuntimeLedger = path.join(restoreDirectory, '.minecraft-core-state', 'runtime.json');
    const candidateRuntimeLedger = path.join(candidatePath, '.minecraft-core-state', 'runtime.json');
    const runtimeLedgerStat = this.fs.lstatSync(restoredRuntimeLedger, { bigint: true });
    const runtimeLedgerReparse = await this.reparseInspector.isReparsePoint(
      restoredRuntimeLedger,
      signal ? { signal } : undefined
    );
    if (this.fs.existsSync(candidateRuntimeLedger) || !runtimeLedgerStat.isFile() || runtimeLedgerStat.isSymbolicLink() ||
        BigInt(runtimeLedgerStat.nlink) !== 1n || runtimeLedgerReparse !== false) throw stale();
    await context.durableFs.renameDurableAsync(restoredRuntimeLedger, candidateRuntimeLedger);
    lease.markDirty();

    const liveHistory = path.join(context.resolved.serverPath, '.minecraft-core-state', 'history');
    const candidateHistory = path.join(candidatePath, '.minecraft-core-state', 'history');
    if (this.fs.existsSync(liveHistory)) {
      await copyServerDirectoryContents(liveHistory, candidateHistory, {
        durableFs: context.durableFs,
        fsApi: this.fs,
        reparseInspector: this.reparseInspector,
        signal
      });
      lease.markDirty();
    }
    const liveBackups = path.join(context.resolved.serverPath, 'backups');
    const candidateBackups = path.join(candidatePath, 'backups');
    if (this.fs.existsSync(liveBackups) && !this.fs.existsSync(candidateBackups)) {
      this.fs.mkdirSync(candidateBackups, { recursive: false });
      await context.durableFs.flushDirectoryAsync(candidatePath);
      await copyServerDirectoryContents(liveBackups, candidateBackups, {
        durableFs: context.durableFs,
        fsApi: this.fs,
        reparseInspector: this.reparseInspector,
        signal
      });
      lease.markDirty();
    }
    await this.#removeControlledEntry(restoreDirectory, candidatePath, signal);
    lease.markDirty();
    Object.assign(context.candidateState, {
      schemaVersion: 1,
      modpackManaged: true,
      source: structuredClone(restored.state.source),
      runtime: structuredClone(restored.state.runtime),
      selectedOptionalFiles: [...restored.state.selectedOptionalFiles],
      installedAt: restored.state.installedAt,
      contentRevision: context.plan.operation.expectedContentRevision + 1,
      manifest: structuredClone(restored.manifest)
    });
  }

  async #persistRollbackCandidateState({ candidatePath, context, jobId }) {
    const written = await this.stateRepository.writeCandidateAsync(candidatePath, context.candidateState);
    const existing = this.stateRepository.listHistory(candidatePath, { cursor: null, limit: 200 });
    const sequence = Math.max(0, ...(existing?.items || []).map(entry => entry.sequence || 0)) + 1;
    const safety = context.restorePoint;
    if (!safety?.id || !safety.sha256) throw stale();
    await this.stateRepository.appendHistoryAsync(candidatePath, {
      schemaVersion: 1,
      operationId: jobId,
      sequence,
      kind: 'rollback',
      outcome: 'completed',
      timestamp: nowDate(this.clock).toISOString(),
      sourceRevision: context.plan.operation.expectedContentRevision,
      targetRevision: context.candidateState.contentRevision,
      ...(context.currentState?.state?.runtime ? { sourceRuntime: context.currentState.state.runtime } : {}),
      targetRuntime: context.candidateState.runtime,
      restorePointId: safety.id,
      restorePointSha256: safety.sha256,
      ...(typeof safety.totalBytes === 'string' ? { restorePointTotalBytes: safety.totalBytes } : {})
    });
    return written;
  }

  async #removeControlledEntry(entryPath, ownedRoot, signal) {
    if (signal?.aborted) throw new ModpackError('CANCELLED', 'The modpack operation was cancelled');
    const relative = path.relative(ownedRoot, entryPath);
    if (!relative || relative.startsWith('..') || path.isAbsolute(relative)) throw invalid();
    const stat = this.fs.lstatSync(entryPath, { bigint: true });
    if (stat.isSymbolicLink() || await this.reparseInspector.isReparsePoint(entryPath, signal ? { signal } : undefined) !== false) {
      throw stale();
    }
    if (stat.isDirectory()) {
      for (const name of this.fs.readdirSync(entryPath)) {
        await this.#removeControlledEntry(path.join(entryPath, name), ownedRoot, signal);
      }
      this.fs.rmdirSync(entryPath);
    } else if (stat.isFile() && BigInt(stat.nlink) === 1n) {
      this.fs.unlinkSync(entryPath);
    } else {
      throw stale();
    }
  }

  async #ensureControlledDirectory(directoryPath, ownedRoot, durableFs, signal) {
    const root = path.resolve(ownedRoot);
    const destination = path.resolve(directoryPath);
    const relative = path.relative(root, destination);
    if (relative.startsWith('..') || path.isAbsolute(relative)) throw stale();
    let current = root;
    for (const segment of relative.split(path.sep).filter(Boolean)) {
      current = path.join(current, segment);
      let stat = this.fs.lstatSync(current, { bigint: true, throwIfNoEntry: false });
      if (!stat) {
        this.fs.mkdirSync(current, { recursive: false, mode: 0o700 });
        await durableFs.flushDirectoryAsync(path.dirname(current));
        stat = this.fs.lstatSync(current, { bigint: true });
      }
      if (!stat.isDirectory() || stat.isSymbolicLink() ||
          await this.reparseInspector.isReparsePoint(current, signal ? { signal } : undefined) !== false) throw stale();
    }
  }

  async #verifyTemplate(context, signal) {
    const expectedTemplateManifest = context.plan.operation.kind === 'repair'
      ? context.executionRecord.execution.repairPayloadManifest
      : context.executionRecord.incomingManifest;
    if (!expectedTemplateManifest) throw stale();
    const rescanned = await scanManifest(
      context.templatePath,
      expectedTemplateManifest.installationId,
      { candidateHashService: this.candidateHashService, reparseInspector: this.reparseInspector, signal }
    );
    exactIncomingManifest(rescanned.manifest, expectedTemplateManifest);
  }

  async #copyReviewedTemplate(candidatePath, context, signal, {
    label = 'reviewed modpack files',
    onProgress
  } = {}) {
    const expectedManifest = context.executionRecord.incomingManifest;
    if (!expectedManifest || !Array.isArray(expectedManifest.entries)) throw stale();
    const expected = new Map();
    const expectedDirectories = new Set();
    let totalBytes = 0n;
    for (const entry of expectedManifest.entries) {
      if (!entry || typeof entry.path !== 'string' || typeof entry.pathKey !== 'string' ||
          typeof entry.installedHash !== 'string' || !/^[a-f0-9]{64}$/u.test(entry.installedHash) ||
          typeof entry.size !== 'string' || !/^(?:0|[1-9]\d*)$/u.test(entry.size)) throw stale();
      const normalized = canonicalPath(entry.path);
      if (normalized.path !== entry.path || normalized.pathKey !== entry.pathKey || expected.has(entry.pathKey)) throw stale();
      expected.set(entry.pathKey, entry);
      totalBytes += BigInt(entry.size);
      const segments = entry.pathKey.split('/');
      for (let length = 1; length < segments.length; length += 1) {
        expectedDirectories.add(segments.slice(0, length).join('/'));
      }
    }
    const totalItems = expected.size;
    const progressMessage = (completedItems, processedBytes) =>
      `Copying ${label} (${completedItems} of ${totalItems} files, ${processedBytes} of ${totalBytes} bytes)`;
    let completedItems = 0;
    let processedBytes = 0n;
    let lastReportedPercent = 40;
    let lastReportedItems = 0;
    await reportCandidateProgress(onProgress, 40, progressMessage(completedItems, processedBytes));
    const planned = new Set();
    const copied = new Set();
    await copyTree(context.templatePath, candidatePath, {
      candidateHashService: this.candidateHashService,
      reparseInspector: this.reparseInspector,
      signal,
      async beforeDirectory({ sourcePath, relativePath }) {
        const normalized = canonicalPath(relativePath.replaceAll('\\', '/'));
        if (expectedDirectories.has(normalized.pathKey)) return true;
        if ((await fsp.readdir(sourcePath)).length === 0) return false;
        throw stale();
      },
      beforeCopy({ relativePath, stat }) {
        if (typeof relativePath !== 'string') throw stale();
        const normalized = canonicalPath(relativePath.replaceAll('\\', '/'));
        const reviewed = expected.get(normalized.pathKey);
        if (!reviewed || planned.has(normalized.pathKey) || reviewed.path !== normalized.path ||
            reviewed.size !== stat.size.toString()) throw stale();
        planned.add(normalized.pathKey);
      },
      async onCopied(_filePath, measured, relativePath) {
        const normalized = canonicalPath(relativePath.replaceAll('\\', '/'));
        const reviewed = expected.get(normalized.pathKey);
        if (!reviewed || !planned.has(normalized.pathKey) || copied.has(normalized.pathKey) ||
            reviewed.path !== normalized.path || reviewed.installedHash !== measured.sha256 ||
            reviewed.size !== measured.size) throw stale();
        copied.add(normalized.pathKey);
        completedItems += 1;
        processedBytes += BigInt(measured.size);
        if (processedBytes > totalBytes) throw stale();
        const measuredPercent = totalBytes > 0n
          ? 40 + Number((processedBytes * 3n) / totalBytes)
          : 40 + Math.floor((completedItems * 3) / Math.max(totalItems, 1));
        const percent = Math.min(43, measuredPercent);
        if (percent > lastReportedPercent || completedItems - lastReportedItems >= 128 || completedItems === totalItems) {
          lastReportedPercent = percent;
          lastReportedItems = completedItems;
          await reportCandidateProgress(onProgress, percent, progressMessage(completedItems, processedBytes));
        }
      }
    });
    if (planned.size !== expected.size || copied.size !== expected.size || processedBytes !== totalBytes) throw stale();
    if (totalItems === 0) {
      await reportCandidateProgress(onProgress, 43, progressMessage(0, 0n));
    }
  }

  async #materializeNewCandidate({ candidatePath, context, choices, lease, signal, onProgress }) {
    await this.#copyReviewedTemplate(candidatePath, context, signal, { onProgress });
    await this.#prepareCandidateRuntime({
      candidatePath, context, choices, lease, signal, onProgress, oldManifest: null
    });
  }

  async #applyExistingCandidate({ candidatePath, context, choices, jobId, lease, signal, onProgress }) {
    await reportCandidateProgress(onProgress, 43, 'Verifying reviewed modpack files');
    await this.#verifyTemplate(context, signal);
    const targetedRepair = context.plan.operation.kind === 'repair';
    const oldEntries = new Map((context.currentState?.manifest?.entries || []).map(entry => [entry.pathKey, entry]));
    const runtimeRepairs = new Map();
    for (const action of context.executionOwnership.actions) {
      if (signal?.aborted) throw new ModpackError('CANCELLED', 'The modpack operation was cancelled');
      const relative = canonicalPath(action.path).path;
      const destination = path.resolve(candidatePath, ...relative.split('/'));
      if (!samePath(path.resolve(candidatePath, path.relative(candidatePath, destination)), destination) ||
          path.relative(candidatePath, destination).startsWith('..')) throw invalid();
      if (['remove', 'remove-user-addon'].includes(action.action)) {
        const stat = this.fs.lstatSync(destination, { bigint: true, throwIfNoEntry: false });
        if (stat) {
          if (!stat.isFile() || stat.isSymbolicLink()) throw stale();
          this.fs.unlinkSync(destination);
          lease.markDirty();
        }
        continue;
      }
      if (action.action === 'disable-user-addon') {
        const disabled = `${destination}.disabled`;
        if (this.fs.existsSync(disabled)) throw stale();
        await context.durableFs.renameDurableAsync(destination, disabled);
        lease.markDirty();
        continue;
      }
      if (!['add', 'seed-protected', 'restore-missing', 'replace', 'keep-both'].includes(action.action)) continue;
      const oldEntry = oldEntries.get(action.pathKey);
      if (targetedRepair && oldEntry?.origin === 'runtime') {
        if (!['replace', 'restore-missing'].includes(action.action) || runtimeRepairs.has(action.pathKey) ||
            oldEntry.managementPolicy !== 'replaceable-managed' ||
            oldEntry.path !== relative) throw stale();
        runtimeRepairs.set(action.pathKey, { action, entry: oldEntry, relative });
        continue;
      }
      const source = path.resolve(context.templatePath, ...relative.split('/'));
      const incomingDestination = action.action === 'keep-both'
        ? path.resolve(candidatePath, ...canonicalPath(action.incomingPath).path.split('/'))
        : destination;
      if (action.action === 'replace' && this.fs.existsSync(incomingDestination)) {
        const stat = this.fs.lstatSync(incomingDestination, { bigint: true });
        if (!stat.isFile() || stat.isSymbolicLink()) throw stale();
        this.fs.unlinkSync(incomingDestination);
      }
      await copyRegularFile(source, incomingDestination, {
        candidateHashService: this.candidateHashService,
        reparseInspector: this.reparseInspector,
        signal,
        replace: false
      });
      lease.markDirty();
    }
    if (targetedRepair) {
      if (choices.acceptEula === true) {
        const eulaPath = path.join(candidatePath, 'eula.txt');
        await context.durableFs.writeFileAtomicAsync(eulaPath, Buffer.from('eula=true\n', 'utf8'));
        lease.markDirty();
      }
      if (runtimeRepairs.size > 0) {
        await this.#repairCandidateRuntimePaths({
          candidatePath,
          context,
          jobId,
          lease,
          repairs: [...runtimeRepairs.values()],
          signal,
          onProgress
        });
      }
      const runtimePathKeys = new Set((context.currentState?.manifest?.entries || [])
        .filter(entry => entry.origin === 'runtime')
        .map(entry => entry.pathKey));
      const candidateManifest = await scanCandidateManifest({
        candidateHashService: this.candidateHashService,
        candidatePath,
        installationId: context.executionRecord.incomingManifest.installationId,
        incomingManifest: context.executionRecord.incomingManifest,
        oldManifest: context.currentState?.manifest || null,
        ownershipPlan: context.executionOwnership,
        runtimePathKeys,
        reparseInspector: this.reparseInspector,
        signal
      });
      for (const repair of runtimeRepairs.values()) {
        const actual = candidateManifest.entries.find(entry => entry.pathKey === repair.entry.pathKey);
        if (!actual || actual.installedHash !== repair.entry.installedHash || actual.size !== repair.entry.size) {
          throw runtimeIncomplete();
        }
      }
      context.candidateState.manifest = candidateManifest;
    } else {
      await this.#prepareCandidateRuntime({
        candidatePath,
        context,
        choices,
        lease,
        signal,
        onProgress,
        oldManifest: context.currentState?.manifest || null
      });
    }
  }

  async #repairCandidateRuntimePaths({ candidatePath, context, jobId, lease, repairs, signal, onProgress }) {
    if (typeof jobId !== 'string' || jobId.length < 1 || !Array.isArray(repairs) || repairs.length < 1) throw stale();
    const operationRoot = path.join(candidatePath, '.minecraft-core-state', 'operations', jobId);
    const stagingPath = path.join(operationRoot, 'runtime-repair');
    const operationStat = this.fs.lstatSync(operationRoot, { bigint: true, throwIfNoEntry: false });
    if (!operationStat?.isDirectory() || operationStat.isSymbolicLink() ||
        await this.reparseInspector.isReparsePoint(operationRoot, signal ? { signal } : undefined) !== false ||
        this.fs.existsSync(stagingPath)) throw stale();
    this.fs.mkdirSync(stagingPath, { recursive: false, mode: 0o700 });
    await context.durableFs.flushDirectoryAsync(operationRoot);
    lease.markDirty();

    let runtimeFailure = null;
    try {
      await this.#withRuntimeWriters(context, lease, async () => {
        const repairsJava = repairs.some(({ entry }) => entry.pathKey === 'java' || entry.pathKey.startsWith('java/'));
        const repairsManagedRuntime = repairs.some(({ entry }) => entry.pathKey !== 'java' && !entry.pathKey.startsWith('java/'));
        let javaPath = null;
        if (repairsManagedRuntime && !repairsJava) {
          const candidateJavaManager = this.javaManagerFactory(candidatePath, {
            onMutation: () => { throw stale(); }
          });
          if (candidateJavaManager && typeof candidateJavaManager.getJavaValidationStatus === 'function') {
            const status = candidateJavaManager.getJavaValidationStatus(context.plan.runtime.javaMajor);
            if (status?.isInstalled === true && typeof status.javaPath === 'string' && path.isAbsolute(status.javaPath)) {
              const relativeJava = path.relative(candidatePath, status.javaPath).replaceAll('\\', '/');
              if (relativeJava && !relativeJava.startsWith('..') && !path.isAbsolute(relativeJava)) {
                const canonicalJava = canonicalPath(relativeJava);
                const baseline = context.currentState?.manifest?.entries?.find(entry => entry.pathKey === canonicalJava.pathKey);
                const javaStat = this.fs.lstatSync(status.javaPath, { bigint: true, throwIfNoEntry: false });
                if (baseline?.origin === 'runtime' && baseline.managementPolicy === 'replaceable-managed' &&
                    javaStat?.isFile() && !javaStat.isSymbolicLink() && BigInt(javaStat.nlink) === 1n &&
                    await this.reparseInspector.isReparsePoint(status.javaPath,
                      signal ? { signal } : undefined) === false) javaPath = status.javaPath;
              }
            }
          }
        }
        if (repairsJava || (repairsManagedRuntime && !javaPath)) {
          const stagingJavaManager = this.javaManagerFactory(stagingPath, { onMutation: () => lease.markDirty() });
          await reportCandidateProgress(onProgress, 44, 'Checking the exact Java runtime');
          const javaProgress = createJavaProgressQueue(onProgress);
          const java = await stagingJavaManager.ensureJava(
            context.plan.runtime.javaMajor,
            value => javaProgress.push(value),
            { signal }
          );
          await javaProgress.drain();
          await reportCandidateProgress(onProgress, 47, 'Exact Java runtime ready');
          if (!java?.success || typeof java.javaPath !== 'string' || !path.isAbsolute(java.javaPath) ||
              path.relative(stagingPath, java.javaPath).startsWith('..') || path.isAbsolute(path.relative(stagingPath, java.javaPath))) {
            throw runtimeIncomplete();
          }
          javaPath = java.javaPath;
        }
        if (repairsManagedRuntime) {
          if (!javaPath) throw runtimeIncomplete();
          await reportCandidateProgress(onProgress, 48, 'Installing the exact server loader runtime');
          await this.prepareRuntime({
            targetPath: stagingPath,
            runtime: context.plan.runtime,
            javaPath,
            skipMutationMark: true,
            signal
          });
          lease.markDirty();
        }
      });

      const staged = await scanManifest(
        stagingPath,
        context.executionRecord.incomingManifest.installationId,
        { candidateHashService: this.candidateHashService, reparseInspector: this.reparseInspector, signal }
      );
      const stagedEntries = new Map(staged.manifest.entries.map(entry => [entry.pathKey, entry]));
      for (const repair of repairs) {
        const stagedEntry = stagedEntries.get(repair.entry.pathKey);
        if (!stagedEntry || stagedEntry.path !== repair.relative ||
            stagedEntry.installedHash !== repair.entry.installedHash || stagedEntry.size !== repair.entry.size) {
          throw runtimeIncomplete();
        }
        const source = path.resolve(stagingPath, ...repair.relative.split('/'));
        const destination = path.resolve(candidatePath, ...repair.relative.split('/'));
        const sourceStat = this.fs.lstatSync(source, { bigint: true, throwIfNoEntry: false });
        if (!sourceStat?.isFile() || sourceStat.isSymbolicLink() || BigInt(sourceStat.nlink) !== 1n ||
            await this.reparseInspector.isReparsePoint(source, signal ? { signal } : undefined) !== false) {
          throw runtimeIncomplete();
        }
        const destinationStat = this.fs.lstatSync(destination, { bigint: true, throwIfNoEntry: false });
        if (destinationStat && (!destinationStat.isFile() || destinationStat.isSymbolicLink() ||
            BigInt(destinationStat.nlink) !== 1n ||
            await this.reparseInspector.isReparsePoint(destination, signal ? { signal } : undefined) !== false)) {
          throw stale();
        }
        if (destinationStat) {
          this.fs.unlinkSync(destination);
          await context.durableFs.flushDirectoryAsync(path.dirname(destination));
        }
        await this.#ensureControlledDirectory(path.dirname(destination), candidatePath, context.durableFs, signal);
        await context.durableFs.renameDurableAsync(source, destination);
        lease.markDirty();
      }
    } catch (error) {
      runtimeFailure = error;
      throw error;
    } finally {
      const quiescent = runtimeFailure?.runtimeWritersUnproven !== true;
      if (quiescent && this.fs.existsSync(stagingPath)) {
        await this.#removeControlledEntry(stagingPath, operationRoot, undefined);
        await context.durableFs.flushDirectoryAsync(operationRoot);
        lease.markDirty();
      }
    }
  }

  async #prepareCandidateRuntime({ candidatePath, context, choices, lease, signal, onProgress, oldManifest }) {
    if (choices.acceptEula === true) {
      const eulaPath = path.join(candidatePath, 'eula.txt');
      await context.durableFs.writeFileAtomicAsync(eulaPath, Buffer.from('eula=true\n', 'utf8'));
      lease.markDirty();
    }
    let beforePaths;
    if (oldManifest === null) {
      beforePaths = new Map(context.executionRecord.incomingManifest.entries.map(entry => [entry.pathKey, entry]));
    } else {
      await reportCandidateProgress(onProgress, 43, 'Hashing candidate content before runtime changes');
      const beforeRuntime = await scanManifest(
        candidatePath,
        context.executionRecord.incomingManifest.installationId,
        { candidateHashService: this.candidateHashService, reparseInspector: this.reparseInspector, signal }
      );
      beforePaths = new Map(beforeRuntime.manifest.entries.map(entry => [entry.pathKey, entry]));
    }
    await this.#withRuntimeWriters(context, lease, async () => {
      const javaManager = this.javaManagerFactory(candidatePath, { onMutation: () => lease.markDirty() });
      await reportCandidateProgress(onProgress, 44, 'Checking the exact Java runtime');
      const javaProgress = createJavaProgressQueue(onProgress);
      const java = await javaManager.ensureJava(
        context.plan.runtime.javaMajor,
        value => javaProgress.push(value),
        { signal }
      );
      await javaProgress.drain();
      await reportCandidateProgress(onProgress, 47, 'Exact Java runtime ready');
      if (!java?.success || typeof java.javaPath !== 'string' || !path.isAbsolute(java.javaPath)) throw runtimeIncomplete();
      await reportCandidateProgress(onProgress, 48, 'Installing the exact server loader runtime');
      await this.prepareRuntime({
        targetPath: candidatePath,
        runtime: context.plan.runtime,
        javaPath: java.javaPath,
        skipMutationMark: true,
        signal
    });
    lease.markDirty();
    });
    const propertiesPath = path.join(candidatePath, 'server.properties');
    const priorProperties = await context.durableFs.readFileBoundedAsync(propertiesPath, {
      allowMissing: true,
      maxBytes: MAX_SERVER_PROPERTIES_BYTES
    });
    const networkProperties = applyServerNetworkProperties(priorProperties, {
      port: context.config.port,
      networkAccess: context.config.networkAccess
    });
    await context.durableFs.writeFileAtomicAsync(propertiesPath, networkProperties);
    lease.markDirty();
    await reportCandidateProgress(onProgress, 49, 'Recording managed runtime file ownership');
    const afterRuntime = await scanManifest(
      candidatePath,
      context.executionRecord.incomingManifest.installationId,
      { candidateHashService: this.candidateHashService, reparseInspector: this.reparseInspector, signal }
    );
    const runtimePathKeys = new Set(afterRuntime.manifest.entries
      .filter(entry => {
        const before = beforePaths.get(entry.pathKey);
        return !before || before.installedHash !== entry.installedHash || before.size !== entry.size;
      })
      .map(entry => entry.pathKey));
    // Classification is synchronous and no candidate mutation occurs after this verified scan.
    context.candidateState.manifest = candidateManifestFromVerifiedScan({
      verifiedManifest: afterRuntime.manifest,
      installationId: context.executionRecord.incomingManifest.installationId,
      incomingManifest: context.executionRecord.incomingManifest,
      oldManifest,
      ownershipPlan: context.executionOwnership,
      runtimePathKeys
    });
  }

  #restoreService(serverPath, durableFs) {
    const key = path.dirname(serverPath).normalize('NFC').toLocaleLowerCase('en-US');
    if (!this.restoreServices.has(key)) {
      const dependencies = {
        fsApi: this.fs,
        durableFs,
        clock: () => nowDate(this.clock),
        randomUUID: this.randomUUID,
        extractVerifiedArchiveFn: createVerifiedRestoreExtractor({
          fsApi: this.fs,
          durableFs,
          reparseInspector: this.reparseInspector
        })
      };
      const service = this.restorePointServiceFactory
        ? this.restorePointServiceFactory(dependencies)
        : new RestorePointService(dependencies);
      if (!service || typeof service.prepareVerifiedRestorePointCreation !== 'function' ||
          typeof service.createVerifiedRestorePoint !== 'function' ||
          typeof service.restoreToOwnedCandidate !== 'function') throw invalid();
      this.restoreServices.set(key, service);
    }
    return this.restoreServices.get(key);
  }

}

module.exports = { ProductionMutationRuntime, scanCandidateManifest, sourceForState };
