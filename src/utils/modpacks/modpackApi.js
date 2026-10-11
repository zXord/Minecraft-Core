const INVOKE = Object.freeze({
  searchCatalog: 'modpacks:search-catalog',
  getProject: 'modpacks:get-project',
  listVersions: 'modpacks:list-versions',
  listGithubReleases: 'modpacks:list-github-releases',
  listGithubAssets: 'modpacks:list-github-assets',
  selectLocalArchive: 'modpacks:select-local-archive',
  reserveServerDestination: 'modpacks:reserve-server-destination',
  releaseServerDestination: 'modpacks:release-server-destination',
  inspect: 'modpacks:inspect',
  cancelInspection: 'modpacks:cancel-inspection',
  preflight: 'modpacks:preflight',
  preflightManagement: 'modpacks:preflight-management',
  startOperation: 'modpacks:start-operation',
  reconcileNewServerLaunch: 'modpacks:reconcile-new-server-launch',
  listNewServerLaunches: 'modpacks:list-new-server-launches',
  cancelJob: 'modpacks:cancel-job',
  getJob: 'modpacks:get-job',
  getActiveJobs: 'modpacks:get-active-jobs',
  getState: 'modpacks:get-state',
  listHistory: 'modpacks:list-history',
  listRollbackOptions: 'modpacks:list-rollback-options',
  listRecovery: 'modpacks:list-recovery',
  recover: 'modpacks:recover',
  listNotifications: 'modpacks:list-notifications',
  ackNotification: 'modpacks:ack-notification',
  checkUpdates: 'modpacks:check-updates',
  updateTracking: 'modpacks:update-tracking',
  verify: 'modpacks:verify',
  performSafeAction: 'modpacks:perform-safe-action'
});

const EVENTS = Object.freeze({
  jobProgress: 'modpacks:job-progress',
  jobLog: 'modpacks:job-log',
  stateChanged: 'modpacks:state-changed',
  notification: 'modpacks:notification',
  inspectionProgress: 'modpacks:inspection-progress',
  preflightProgress: 'modpacks:preflight-progress'
});

let inspectionRequestSequence = 0;
let preflightRequestSequence = 0;

export class ModpackApiError extends Error {
  constructor(error = {}) {
    super(error.message || 'The modpack request could not be completed.');
    this.name = 'ModpackApiError';
    this.code = error.code || 'COMMIT_FAILED';
    this.details = error.details || {};
    this.retryable = Boolean(error.retryable);
  }
}

function bridge() {
  if (typeof window === 'undefined' || !window.electron?.invoke) {
    throw new ModpackApiError({ code: 'ARCHIVE_RUNTIME_UNAVAILABLE', message: 'The desktop modpack service is unavailable.' });
  }
  return window.electron;
}

async function invoke(channel, request = {}) {
  const result = await bridge().invoke(channel, request);
  if (!result || result.ok !== true) throw new ModpackApiError(result?.error);
  return result.value;
}

function listen(channel, callback) {
  if (typeof callback !== 'function') return () => {};
  const electron = bridge();
  const handler = payload => callback(payload);
  electron.on(channel, handler);
  let active = true;
  return () => {
    if (!active) return;
    active = false;
    electron.removeListener(channel, handler);
  };
}

function createInspectionRequestId() {
  inspectionRequestSequence += 1;
  const random = globalThis.crypto?.randomUUID?.() || `${Date.now().toString(36)}-${inspectionRequestSequence.toString(36)}`;
  return `inspect-${random}`;
}

function createPreflightRequestId() {
  preflightRequestSequence += 1;
  const random = globalThis.crypto?.randomUUID?.() || `${Date.now().toString(36)}-${preflightRequestSequence.toString(36)}`;
  return `preflight-${random}`;
}

function inspectionSignal(options) {
  if (options === undefined) return undefined;
  const keys = options && typeof options === 'object' && !Array.isArray(options) ? Object.keys(options) : [];
  const signal = keys.length === 1 && keys[0] === 'signal' ? options.signal : undefined;
  if (!signal || typeof signal.aborted !== 'boolean' || typeof signal.addEventListener !== 'function' ||
      typeof signal.removeEventListener !== 'function') {
    throw new ModpackApiError({ code: 'INVALID_REQUEST', message: 'The inspection cancellation request is invalid.' });
  }
  return signal;
}

async function inspect(request = {}, onProgress, options) {
  const electron = bridge();
  const requestId = createInspectionRequestId();
  const signal = inspectionSignal(options);
  if (signal?.aborted) {
    throw new ModpackApiError({ code: 'CANCELLED', message: 'Archive inspection was cancelled.' });
  }
  let cancellation = null;
  const cancel = () => {
    if (!cancellation) {
      cancellation = electron.invoke(INVOKE.cancelInspection, { requestId }).catch(() => null);
    }
  };
  const handler = event => {
    if (event?.requestId !== requestId || typeof onProgress !== 'function') return;
    try { onProgress(event); } catch { /* renderer callbacks cannot affect main-process inspection */ }
  };
  if (typeof onProgress === 'function') electron.on(EVENTS.inspectionProgress, handler);
  try {
    const inspection = electron.invoke(INVOKE.inspect, { ...request, requestId });
    signal?.addEventListener('abort', cancel, { once: true });
    if (signal?.aborted) cancel();
    const result = await inspection;
    if (!result || result.ok !== true) throw new ModpackApiError(result?.error);
    if (signal?.aborted) {
      await cancellation;
      throw new ModpackApiError({ code: 'CANCELLED', message: 'Archive inspection was cancelled.' });
    }
    return result.value;
  } finally {
    signal?.removeEventListener('abort', cancel);
    if (typeof onProgress === 'function') electron.removeListener(EVENTS.inspectionProgress, handler);
  }
}

async function preflight(request = {}, onProgress) {
  const electron = bridge();
  const requestId = createPreflightRequestId();
  const handler = event => {
    if (event?.requestId !== requestId || typeof onProgress !== 'function') return;
    try { onProgress(event); } catch { /* renderer callbacks cannot affect main-process planning */ }
  };
  if (typeof onProgress === 'function') electron.on(EVENTS.preflightProgress, handler);
  try {
    const result = await electron.invoke(INVOKE.preflight, { ...request, requestId });
    if (!result || result.ok !== true) throw new ModpackApiError(result?.error);
    return result.value;
  } finally {
    if (typeof onProgress === 'function') electron.removeListener(EVENTS.preflightProgress, handler);
  }
}

async function preflightManagement(serverId, operationKind, selectionRef = null, onProgress) {
  const electron = bridge();
  const requestId = createPreflightRequestId();
  const handler = event => {
    if (event?.requestId !== requestId || typeof onProgress !== 'function') return;
    try { onProgress(event); } catch { /* renderer callbacks cannot affect main-process planning */ }
  };
  if (typeof onProgress === 'function') electron.on(EVENTS.preflightProgress, handler);
  try {
    const result = await electron.invoke(INVOKE.preflightManagement, {
      serverId,
      operationKind,
      selectionRef,
      requestId
    });
    if (!result || result.ok !== true) throw new ModpackApiError(result?.error);
    return result.value;
  } finally {
    if (typeof onProgress === 'function') electron.removeListener(EVENTS.preflightProgress, handler);
  }
}

export function isPlanStaleError(error) {
  return Boolean(error && typeof error === 'object' && error.code === 'PLAN_STALE');
}

export const modpackApi = Object.freeze({
  searchCatalog: request => invoke(INVOKE.searchCatalog, request),
  getProject: projectId => invoke(INVOKE.getProject, { projectId }),
  listVersions: request => invoke(INVOKE.listVersions, request),
  listGithubReleases: request => invoke(INVOKE.listGithubReleases, request),
  listGithubAssets: request => invoke(INVOKE.listGithubAssets, request),
  selectLocalArchive: (allowMultipart = true) => invoke(INVOKE.selectLocalArchive, { allowMultipart }),
  reserveServerDestination: () => invoke(INVOKE.reserveServerDestination, {}),
  releaseServerDestination: instanceId => invoke(INVOKE.releaseServerDestination, { instanceId }),
  inspect,
  discardInspection: inspectionId => invoke(INVOKE.cancelInspection, { inspectionId }),
  preflight,
  preflightManagement,
  startOperation: ({ planId, planFingerprint, choices }) => invoke(INVOKE.startOperation, {
    planId,
    planFingerprint,
    choices
  }),
  cancelJob: jobId => invoke(INVOKE.cancelJob, { jobId }),
  reconcileNewServerLaunch: request => invoke(INVOKE.reconcileNewServerLaunch, request),
  listNewServerLaunches: (request = {}) => invoke(INVOKE.listNewServerLaunches, request),
  getJob: jobId => invoke(INVOKE.getJob, { jobId }),
  getActiveJobs: serverId => invoke(INVOKE.getActiveJobs, { serverId }),
  getState: serverId => invoke(INVOKE.getState, { serverId }),
  listHistory: (serverId, cursor = null, limit = 50) => invoke(INVOKE.listHistory, { serverId, cursor, limit }),
  listRollbackOptions: serverId => invoke(INVOKE.listRollbackOptions, { serverId }),
  listRecovery: () => invoke(INVOKE.listRecovery, {}),
  recover: (recoveryId, actionId) => invoke(INVOKE.recover, { recoveryId, actionId }),
  listNotifications: (request = {}) => invoke(INVOKE.listNotifications, request),
  ackNotification: notificationId => invoke(INVOKE.ackNotification, { notificationId }),
  checkUpdates: (trackingId = null, force = false) => invoke(INVOKE.checkUpdates, { trackingId, force }),
  updateTracking: request => invoke(INVOKE.updateTracking, request),
  verify: serverId => invoke(INVOKE.verify, { serverId }),
  performSafeAction: (actionId, opaqueRef) => invoke(INVOKE.performSafeAction, {
    actionId,
    ...(opaqueRef ? { opaqueRef } : {})
  }),
  onJobProgress: callback => listen(EVENTS.jobProgress, callback),
  onJobLog: callback => listen(EVENTS.jobLog, callback),
  onStateChanged: callback => listen(EVENTS.stateChanged, callback),
  onNotification: callback => listen(EVENTS.notification, callback)
});

export { INVOKE as modpackInvokeChannels, EVENTS as modpackEventChannels };
