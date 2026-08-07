const INVOKE = Object.freeze({
  searchCatalog: 'modpacks:search-catalog',
  getProject: 'modpacks:get-project',
  listVersions: 'modpacks:list-versions',
  listGithubReleases: 'modpacks:list-github-releases',
  listGithubAssets: 'modpacks:list-github-assets',
  selectLocalArchive: 'modpacks:select-local-archive',
  reserveServerDestination: 'modpacks:reserve-server-destination',
  inspect: 'modpacks:inspect',
  preflight: 'modpacks:preflight',
  preflightManagement: 'modpacks:preflight-management',
  startOperation: 'modpacks:start-operation',
  cancelJob: 'modpacks:cancel-job',
  getJob: 'modpacks:get-job',
  getState: 'modpacks:get-state',
  listHistory: 'modpacks:list-history',
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
  notification: 'modpacks:notification'
});

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

export const modpackApi = Object.freeze({
  searchCatalog: request => invoke(INVOKE.searchCatalog, request),
  getProject: projectId => invoke(INVOKE.getProject, { projectId }),
  listVersions: request => invoke(INVOKE.listVersions, request),
  listGithubReleases: request => invoke(INVOKE.listGithubReleases, request),
  listGithubAssets: request => invoke(INVOKE.listGithubAssets, request),
  selectLocalArchive: (allowMultipart = true) => invoke(INVOKE.selectLocalArchive, { allowMultipart }),
  reserveServerDestination: () => invoke(INVOKE.reserveServerDestination, {}),
  inspect: request => invoke(INVOKE.inspect, request),
  preflight: request => invoke(INVOKE.preflight, request),
  preflightManagement: (serverId, operationKind, selectionRef = null) => invoke(INVOKE.preflightManagement, {
    serverId,
    operationKind,
    selectionRef
  }),
  startOperation: ({ planId, planFingerprint, choices }) => invoke(INVOKE.startOperation, {
    planId,
    planFingerprint,
    choices
  }),
  cancelJob: jobId => invoke(INVOKE.cancelJob, { jobId }),
  getJob: jobId => invoke(INVOKE.getJob, { jobId }),
  getState: serverId => invoke(INVOKE.getState, { serverId }),
  listHistory: (serverId, cursor = null, limit = 50) => invoke(INVOKE.listHistory, { serverId, cursor, limit }),
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
