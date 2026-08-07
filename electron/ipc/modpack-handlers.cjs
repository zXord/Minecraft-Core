const { ModpackError, deepFreeze } = require('../services/modpacks/errors.cjs');
const { matchAssetPatternProvisional } = require('../services/modpacks/providers/github-asset-pattern.cjs');
const {
  MODPACK_INVOKE_CHANNELS,
  validateModpackIpcRequest,
  validateModpackIpcResult
} = require('../services/modpacks/ipc-schemas.cjs');

function invalid(cause) {
  if (cause instanceof ModpackError) return cause;
  return new ModpackError('INVALID_REQUEST', 'Modpack IPC dependencies are invalid', { cause });
}

function requireMethods(value, methods) {
  if (!value || typeof value !== 'object' || methods.some(method => typeof value[method] !== 'function')) throw invalid();
  return value;
}

function publicFailure(error) {
  if (error instanceof ModpackError) return error.toPublicResult();
  return new ModpackError('COMMIT_FAILED', 'Minecraft Core could not complete the modpack request', { cause: error }).toPublicResult();
}

function publicModrinthVersions(versions) {
  if (!Array.isArray(versions)) return versions;
  return versions.map(version => ({
    ...version,
    ...(Array.isArray(version.files) ? {
      files: version.files.map(file => {
        const { downloadUrlCandidate: _privateAcquisitionUrl, ...visible } = file;
        return visible;
      })
    } : {})
  }));
}

function provisionalGithubChoices(choices) {
  if (!Array.isArray(choices)) return [];
  return choices.map(choice => {
    const parts = Array.isArray(choice?.parts) ? choice.parts : [];
    return {
      assetIds: parts.map(part => part?.providerAssetId),
      fileNames: parts.map(part => part?.fileName),
      multipartStructure: {
        kind: choice?.kind,
        groupingScheme: choice?.groupingScheme,
        partCount: parts.length,
        primaryIndex: parts.findIndex(part => part?.providerAssetId === choice?.primaryPartId)
      },
      complete: choice?.complete === true
    };
  });
}

function createModpackHandlers({
  providers,
  localArtifactSource,
  destinationReservationService,
  lifecycleService,
  recoveryService,
  notificationStore,
  releaseMonitor,
  releaseTrackingStore,
  outcomeActionService
} = {}) {
  const modrinth = requireMethods(providers?.modrinth, ['searchProjects', 'getProject', 'listVersions']);
  const github = requireMethods(providers?.github, ['listReleases', 'loadUploadedAssets']);
  requireMethods(localArtifactSource, ['selectWithNativeDialog']);
  requireMethods(destinationReservationService, ['reserveWithNativeDialog']);
  requireMethods(lifecycleService, [
    'inspectSource', 'createPlan', 'createManagementPlan', 'startOperation', 'cancelJob', 'getJob', 'getState', 'listHistory', 'verify'
  ]);
  requireMethods(recoveryService, ['listRecovery', 'recover']);
  requireMethods(notificationStore, ['list', 'acknowledge']);
  requireMethods(releaseMonitor, ['checkAll', 'checkOne']);
  requireMethods(releaseTrackingStore, ['upsert', 'list']);
  requireMethods(outcomeActionService, ['performSafeAction']);

  const operations = {
    'modpacks:search-catalog': request => modrinth.searchProjects(request),
    'modpacks:get-project': request => modrinth.getProject(request.projectId),
    'modpacks:list-versions': async request => publicModrinthVersions(await modrinth.listVersions(request)),
    'modpacks:list-github-releases': async request => {
      if (typeof github.getRepositoryIdentity !== 'function') return github.listReleases(request);
      const repository = await github.getRepositoryIdentity(request.repositoryUrl);
      return github.listReleases({
        repositoryId: repository.repositoryId,
        owner: repository.owner,
        repo: repository.repo,
        includePrereleases: request.includePrereleases,
        ...(request.cursor ? { cursor: request.cursor } : {})
      });
    },
    'modpacks:list-github-assets': async request => {
      const listing = await github.loadUploadedAssets({
        repositoryId: request.repositoryId,
        releaseId: request.releaseId
      });
      if (!request.serverId) return listing;
      const records = await releaseTrackingStore.list();
      const tracking = records.find(record => record?.serverId === request.serverId &&
        record.provider === 'github' && record.repositoryId === request.repositoryId);
      if (!tracking?.assetPattern) return listing;
      const match = matchAssetPatternProvisional(tracking.assetPattern, provisionalGithubChoices(listing.choices));
      return match.type === 'SINGLE_PROVISIONAL'
        ? { ...listing, suggestedAssetIds: match.selectedAssetIds }
        : listing;
    },
    'modpacks:select-local-archive': request => localArtifactSource.selectWithNativeDialog(request),
    'modpacks:reserve-server-destination': request => destinationReservationService.reserveWithNativeDialog(request),
    'modpacks:inspect': request => lifecycleService.inspectSource(request),
    'modpacks:preflight': request => lifecycleService.createPlan(request),
    'modpacks:preflight-management': request => lifecycleService.createManagementPlan({
      instanceId: request.serverId,
      operationKind: request.operationKind,
      ...(request.selectionRef == null ? {} : { selectionRef: request.selectionRef })
    }),
    'modpacks:start-operation': request => lifecycleService.startOperation(request),
    'modpacks:cancel-job': request => lifecycleService.cancelJob(request.jobId),
    'modpacks:get-job': request => lifecycleService.getJob(request.jobId),
    'modpacks:get-state': request => lifecycleService.getState(request.serverId),
    'modpacks:list-history': request => lifecycleService.listHistory(request.serverId, {
      cursor: request.cursor ?? null,
      limit: request.limit ?? 50
    }),
    'modpacks:list-recovery': () => recoveryService.listRecovery(),
    'modpacks:recover': request => recoveryService.recover(request),
    'modpacks:list-notifications': request => notificationStore.list(request),
    'modpacks:ack-notification': request => notificationStore.acknowledge(request.notificationId),
    'modpacks:check-updates': request => request.trackingId
      ? releaseMonitor.checkOne(request.trackingId, { force: request.force ?? false })
      : releaseMonitor.checkAll({ force: request.force ?? false }),
    'modpacks:update-tracking': request => releaseTrackingStore.upsert(request),
    'modpacks:verify': request => lifecycleService.verify(request.serverId),
    'modpacks:perform-safe-action': request => outcomeActionService.performSafeAction(request)
  };

  const handlers = Object.fromEntries(MODPACK_INVOKE_CHANNELS.map(channel => [channel, async (_event, request = {}) => {
    try {
      const normalized = validateModpackIpcRequest(channel, request);
      const value = await operations[channel](normalized);
      return validateModpackIpcResult(channel, { ok: true, value });
    } catch (error) {
      return validateModpackIpcResult(channel, publicFailure(error));
    }
  }]));
  return deepFreeze(handlers);
}

module.exports = { createModpackHandlers, MODPACK_INVOKE_CHANNELS };
