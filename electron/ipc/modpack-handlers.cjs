const { MODPACK_SERVICES_UNAVAILABLE_MESSAGE, ModpackError, deepFreeze } = require('../services/modpacks/errors.cjs');
const { matchAssetPatternProvisional } = require('../services/modpacks/providers/github-asset-pattern.cjs');
const {
  MODPACK_INVOKE_CHANNELS,
  validateModpackIpcEvent,
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

function modpackServicesUnavailable() {
  return new ModpackError('MODPACK_SERVICES_UNAVAILABLE', MODPACK_SERVICES_UNAVAILABLE_MESSAGE);
}

function closedCode(value) {
  return typeof value === 'string' && /^[A-Za-z][A-Za-z0-9_-]{0,63}$/u.test(value) ? value : null;
}

// A review refused as stale leaves only its closed codes in the app log, for
// triage on the user's machine: the reason the main process gave and the file
// system error behind it. Never a path or a message.
function logStaleReview(logger, operation, error) {
  if (!(error instanceof ModpackError) || error.code !== 'PLAN_STALE') return;
  let cause = error.cause;
  while (cause instanceof ModpackError) cause = cause.cause;
  try {
    logger?.warn?.('A modpack review was refused as stale', {
      category: 'core',
      data: { operation, code: error.code, reasonCode: closedCode(error.details?.reasonCode), causeCode: closedCode(cause?.code) }
    });
  } catch {
    // Logging never changes a review's outcome.
  }
}

// One handler per modpack channel: the request is validated, the operation (or
// the fallback for a channel without one) runs, and the result or the public
// failure is validated against the channel's schema.
function createChannelHandlers(operations, fallback = null) {
  const handlers = Object.fromEntries(MODPACK_INVOKE_CHANNELS.map(channel => [channel, async (event, request = {}) => {
    try {
      const normalized = validateModpackIpcRequest(channel, request);
      const operation = operations[channel] || fallback;
      if (typeof operation !== 'function') throw invalid();
      const value = await operation(normalized, event);
      return validateModpackIpcResult(channel, { ok: true, value }, normalized);
    } catch (error) {
      return validateModpackIpcResult(channel, publicFailure(error));
    }
  }]));
  return deepFreeze(handlers);
}

function inspectionProgressSink(sender, requestId) {
  if (typeof requestId !== 'string' || !sender || typeof sender.send !== 'function') return null;
  const intervalMs = 200;
  let currentPhase = null;
  let lastSent = null;
  let pending = null;
  let timer = null;
  let closed = false;

  const sameEvent = (left, right) => left && right &&
    left.phase === right.phase && left.transferredBytes === right.transferredBytes &&
    left.totalBytes === right.totalBytes && left.percent === right.percent;
  const clearTimer = () => {
    if (timer !== null) clearTimeout(timer);
    timer = null;
  };
  const send = event => {
    try {
      sender.send('modpacks:inspection-progress', event);
    } catch {
      // Progress transport is best-effort and must not change inspection outcome.
    }
    lastSent = event;
  };
  const flush = () => {
    clearTimer();
    if (!pending) return;
    const event = pending;
    pending = null;
    if (!sameEvent(event, lastSent)) send(event);
  };
  const schedule = () => {
    if (timer !== null) return;
    timer = setTimeout(() => {
      timer = null;
      if (!closed) flush();
    }, intervalMs);
    timer.unref?.();
  };
  const report = progress => {
    if (closed) return;
    let event;
    try {
      event = validateModpackIpcEvent('modpacks:inspection-progress', { ...progress, requestId });
    } catch {
      return;
    }

    if (event.phase !== currentPhase) {
      flush();
      currentPhase = event.phase;
      send(event);
      if (event.phase === 'complete') closed = true;
      return;
    }
    if (event.phase === 'complete' || sameEvent(event, lastSent) || sameEvent(event, pending)) return;

    if (Number.isInteger(event.percent) && event.percent !== lastSent?.percent) {
      pending = null;
      clearTimer();
      send(event);
      return;
    }
    pending = event;
    if (!Number.isInteger(event.percent)) schedule();
  };
  return {
    report,
    close() {
      if (closed) return;
      flush();
      closed = true;
    }
  };
}

function preflightProgressSink(sender, requestId) {
  if (typeof requestId !== 'string' || !sender || typeof sender.send !== 'function') return null;
  const intervalMs = 200;
  let currentPhase = null;
  let currentActivity = null;
  let lastSent = null;
  let pending = null;
  let timer = null;
  let closed = false;

  const sameEvent = (left, right) => left && right &&
    left.phase === right.phase && left.activity === right.activity &&
    left.completedItems === right.completedItems && left.totalItems === right.totalItems &&
    left.processedBytes === right.processedBytes && left.totalBytes === right.totalBytes;
  const sameGroup = event => event.phase === currentPhase && (event.activity ?? null) === currentActivity;
  const isDeterminate = event =>
    (Number.isInteger(event.totalBytes) && event.totalBytes > 0) ||
    (Number.isInteger(event.totalItems) && event.totalItems > 0);
  const isExactCompletion = event => {
    const completions = [];
    if (Number.isInteger(event.totalBytes) && event.totalBytes > 0) {
      completions.push(event.processedBytes === event.totalBytes);
    }
    if (Number.isInteger(event.totalItems) && event.totalItems > 0) {
      completions.push(event.completedItems === event.totalItems);
    }
    return completions.length > 0 && completions.every(Boolean);
  };
  const clearTimer = () => {
    if (timer !== null) clearTimeout(timer);
    timer = null;
  };
  const send = event => {
    try {
      sender.send('modpacks:preflight-progress', event);
    } catch {
      // Progress transport is best-effort and must not change planning outcome.
    }
    lastSent = event;
  };
  const flush = () => {
    clearTimer();
    if (!pending) return;
    const event = pending;
    pending = null;
    if (!sameEvent(event, lastSent)) send(event);
  };
  const schedule = () => {
    if (timer !== null) return;
    timer = setTimeout(() => {
      timer = null;
      if (!closed) flush();
    }, intervalMs);
    timer.unref?.();
  };

  return {
    report(progress) {
      if (closed) return;
      let event;
      try {
        event = validateModpackIpcEvent('modpacks:preflight-progress', { ...progress, requestId });
      } catch {
        return;
      }

      if (!sameGroup(event)) {
        flush();
        currentPhase = event.phase;
        currentActivity = event.activity ?? null;
        send(event);
        if (event.phase === 'complete') closed = true;
        return;
      }

      if (sameEvent(event, lastSent) || sameEvent(event, pending)) return;
      if (isExactCompletion(event)) {
        pending = null;
        clearTimer();
        send(event);
        return;
      }
      if (!isDeterminate(event)) {
        send(event);
        return;
      }
      pending = event;
      schedule();
    },
    close() {
      if (closed) return;
      flush();
      closed = true;
    }
  };
}

function copyDefined(target, source, keys) {
  for (const key of keys) {
    if (source[key] !== undefined) target[key] = source[key];
  }
  return target;
}

function displayText(value) {
  if (typeof value !== 'string') return value;
  return value.replace(/https?:\/\/[^\s<>"']+/giu, match => {
    const trailing = match.match(/[),.;:!?_]+$/u)?.[0] || '';
    return `[external link]${trailing}`;
  });
}

function publicModrinthCatalogProject(project) {
  if (!project || typeof project !== 'object' || Array.isArray(project)) return project;
  const visible = copyDefined({}, project, [
    'projectId', 'slug', 'categories', 'minecraftVersions', 'loaders',
    'serverCompatibility', 'updatedAt', 'downloads', 'iconUrlCandidate', 'galleryUrlCandidates'
  ]);
  if (project.title !== undefined) visible.title = displayText(project.title);
  if (project.summary !== undefined) visible.summary = displayText(project.summary);
  return visible;
}

function publicModrinthCatalog(catalog) {
  if (!catalog || typeof catalog !== 'object' || Array.isArray(catalog)) return catalog;
  const visible = copyDefined({}, catalog, ['pagination']);
  if (Array.isArray(catalog.items)) visible.items = catalog.items.map(publicModrinthCatalogProject);
  return visible;
}

function publicModrinthProject(project) {
  if (!project || typeof project !== 'object' || Array.isArray(project)) return project;
  const visible = copyDefined({}, project, [
    'projectId', 'slug', 'runtimes', 'serverCompatibility', 'updatedAt', 'downloads', 'iconUrlCandidate'
  ]);
  if (project.title !== undefined) visible.title = displayText(project.title);
  if (project.summary !== undefined) visible.summary = displayText(project.summary);
  if (Array.isArray(project.galleryCandidates)) {
    visible.galleryCandidates = project.galleryCandidates.map(candidate => copyDefined({}, candidate, [
      'urlCandidate', 'featured', 'title'
    ]));
    visible.galleryCandidates.forEach(candidate => {
      if (candidate.title !== undefined) candidate.title = displayText(candidate.title);
    });
  }
  if (Array.isArray(project.upstreamLinkCandidates)) {
    visible.upstreamLinkCandidates = project.upstreamLinkCandidates.map(candidate => {
      const link = copyDefined({}, candidate, ['kind', 'urlCandidate', 'label']);
      if (link.label !== undefined) link.label = displayText(link.label);
      return link;
    });
  }
  return visible;
}

function publicModrinthVersions(versions) {
  if (!Array.isArray(versions)) return versions;
  return versions.map(version => {
    if (!version || typeof version !== 'object' || Array.isArray(version)) return version;
    const visible = copyDefined({}, version, [
      'versionId', 'projectId', 'channel', 'minecraftVersions', 'loaders', 'publishedAt', 'downloads'
    ]);
    if (version.name !== undefined) visible.name = displayText(version.name);
    if (version.version !== undefined) visible.version = displayText(version.version);
    return visible;
  });
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
  outcomeActionService,
  logger = null
} = {}) {
  const modrinth = requireMethods(providers?.modrinth, ['searchProjects', 'getProject', 'listVersions']);
  const github = requireMethods(providers?.github, ['listReleases', 'loadUploadedAssets']);
  requireMethods(localArtifactSource, ['selectWithNativeDialog']);
  requireMethods(destinationReservationService, ['reserveWithNativeDialog', 'release']);
  requireMethods(lifecycleService, [
    'inspectSource', 'cancelInspection', 'createPlan', 'createManagementPlan', 'startOperation', 'cancelJob', 'getJob', 'getActiveJobs', 'getState', 'listHistory',
    'listRollbackOptions', 'verify'
  ]);
  requireMethods(recoveryService, ['listRecovery', 'recover']);
  requireMethods(notificationStore, ['list', 'acknowledge']);
  requireMethods(releaseMonitor, ['checkAll', 'checkOne']);
  requireMethods(releaseTrackingStore, ['upsert', 'list']);
  requireMethods(outcomeActionService, ['performSafeAction']);

  const activeInspectionRequests = new Map();
  const completedInspectionRequests = new Map();
  const completedInspectionOwners = new Map();

  const senderId = event => {
    const value = event?.sender?.id;
    return Number.isSafeInteger(value) && value >= 0 ? value : null;
  };

  const requestKey = (event, requestId) => {
    const ownerId = senderId(event);
    return ownerId !== null && typeof requestId === 'string'
      ? `${ownerId}:${requestId}`
      : null;
  };

  const forgetCompletedRequestAlias = record => {
    if (record.key && completedInspectionRequests.get(record.key) === record) {
      completedInspectionRequests.delete(record.key);
    }
    if (record.timer !== null) clearTimeout(record.timer);
    record.timer = null;
  };

  const disposeCompletedInspection = record => {
    forgetCompletedRequestAlias(record);
    if (completedInspectionOwners.get(record.inspectionId) === record) {
      completedInspectionOwners.delete(record.inspectionId);
    }
    record.sender?.removeListener?.('destroyed', record.onDestroyed);
  };

  const rememberCompletedInspection = (key, sender, inspectionId) => {
    const ownerId = senderId({ sender });
    if (ownerId === null || typeof inspectionId !== 'string') return;
    const prior = key ? completedInspectionRequests.get(key) : null;
    if (prior) forgetCompletedRequestAlias(prior);
    if (completedInspectionOwners.has(inspectionId)) {
      throw new ModpackError('PLAN_STALE', 'The reviewed archive inspection is stale');
    }
    const record = {
      key,
      sender,
      senderId: ownerId,
      inspectionId,
      timer: null,
      onDestroyed: null
    };
    record.onDestroyed = () => {
      forgetCompletedRequestAlias(record);
      // Record trusted teardown synchronously, before the current preflight can settle/seal.
      record.disposal = Promise.resolve(typeof lifecycleService.disposeInspection === 'function'
        ? lifecycleService.disposeInspection(inspectionId)
        : lifecycleService.cancelInspection(inspectionId));
      void record.disposal
        .then(() => disposeCompletedInspection(record))
        .catch(() => {});
    };
    record.timer = setTimeout(() => forgetCompletedRequestAlias(record), 5_000);
    record.timer.unref?.();
    sender?.once?.('destroyed', record.onDestroyed);
    if (key) completedInspectionRequests.set(key, record);
    completedInspectionOwners.set(inspectionId, record);
  };

  const cancelOwnedCompletedInspection = async (record, event) => {
    if (!record || senderId(event) !== record.senderId) return false;
    const result = await lifecycleService.cancelInspection(record.inspectionId);
    disposeCompletedInspection(record);
    return result;
  };

  const operations = {
    'modpacks:search-catalog': async request => publicModrinthCatalog(await modrinth.searchProjects(request)),
    'modpacks:get-project': async request => publicModrinthProject(await modrinth.getProject(request.projectId)),
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
    'modpacks:release-server-destination': request => requireMethods(lifecycleService, ['releaseServerDestination']).releaseServerDestination(request.instanceId),
    'modpacks:inspect': async (request, event) => {
      const { requestId, ...sourceRequest } = request;
      const progress = inspectionProgressSink(event?.sender, requestId);
      const controller = new AbortController();
      const key = requestKey(event, requestId);
      if (key && activeInspectionRequests.has(key)) {
        throw new ModpackError('OPERATION_IN_PROGRESS', 'This archive inspection request is already active');
      }
      const onDestroyed = () => controller.abort();
      const session = { controller };
      if (key) activeInspectionRequests.set(key, session);
      event?.sender?.once?.('destroyed', onDestroyed);
      try {
        const inspected = await lifecycleService.inspectSource(sourceRequest, {
          signal: controller.signal,
          ...(progress ? { onProgress: progress.report } : {})
        });
        if (controller.signal.aborted) {
          await lifecycleService.cancelInspection(inspected.inspectionId);
          throw new ModpackError('CANCELLED', 'Archive inspection was cancelled');
        }
        rememberCompletedInspection(key, event?.sender, inspected.inspectionId);
        return inspected;
      } finally {
        if (key && activeInspectionRequests.get(key) === session) activeInspectionRequests.delete(key);
        event?.sender?.removeListener?.('destroyed', onDestroyed);
        progress?.close();
      }
    },
    'modpacks:cancel-inspection': async (request, event) => {
      if (request.inspectionId) {
        return cancelOwnedCompletedInspection(completedInspectionOwners.get(request.inspectionId), event);
      }
      const key = requestKey(event, request.requestId);
      if (!key) return false;
      const active = activeInspectionRequests.get(key);
      if (active) {
        active.controller.abort();
        return true;
      }
      const completed = completedInspectionRequests.get(key);
      if (!completed) return false;
      return cancelOwnedCompletedInspection(completed, event);
    },
    'modpacks:preflight': async (request, event) => {
      const { requestId, ...planRequest } = request;
      const progress = preflightProgressSink(event?.sender, requestId);
      const owner = completedInspectionOwners.get(planRequest.inspectionId);
      if (owner && owner.senderId !== senderId(event)) {
        throw new ModpackError('INVALID_REQUEST', 'The archive inspection does not belong to this renderer');
      }
      try {
        const result = await lifecycleService.createPlan(planRequest, {
          ...(progress ? { onProgress: progress.report } : {})
        });
        if (owner?.disposal) {
          if (result?.planId) await lifecycleService.disposeUndeliverablePlan(result);
          await owner.disposal;
          throw new ModpackError('CANCELLED', 'Archive preflight owner was destroyed');
        }
        if (owner && result?.planId) disposeCompletedInspection(owner);
        return result;
      } catch (error) {
        logStaleReview(logger, 'preflight', error);
        throw error;
      } finally {
        progress?.close();
      }
    },
    'modpacks:preflight-management': async (request, event) => {
      const { requestId, ...managementRequest } = request;
      const progress = preflightProgressSink(event?.sender, requestId);
      try {
        return await lifecycleService.createManagementPlan({
          instanceId: managementRequest.serverId,
          operationKind: managementRequest.operationKind,
          ...(managementRequest.selectionRef == null ? {} : { selectionRef: managementRequest.selectionRef })
        }, {
          ...(progress ? { onProgress: progress.report } : {})
        });
      } catch (error) {
        logStaleReview(logger, 'preflight-management', error);
        throw error;
      } finally {
        progress?.close();
      }
    },
    'modpacks:start-operation': request => lifecycleService.startOperation(request),
    'modpacks:reconcile-new-server-launch': request => {
      if (typeof lifecycleService.reconcileNewServerLaunch !== 'function') throw invalid();
      return lifecycleService.reconcileNewServerLaunch(request);
    },
    'modpacks:list-new-server-launches': request => {
      if (typeof lifecycleService.listNewServerLaunches !== 'function') throw invalid();
      return lifecycleService.listNewServerLaunches(request);
    },
    'modpacks:cancel-job': request => lifecycleService.cancelJob(request.jobId),
    'modpacks:get-job': request => lifecycleService.getJob(request.jobId),
    'modpacks:get-active-jobs': request => lifecycleService.getActiveJobs(request.serverId),
    'modpacks:get-state': request => lifecycleService.getState(request.serverId),
    'modpacks:list-history': request => lifecycleService.listHistory(request.serverId, {
      cursor: request.cursor ?? null,
      limit: request.limit ?? 50
    }),
    'modpacks:list-rollback-options': request => lifecycleService.listRollbackOptions(request.serverId),
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

  return createChannelHandlers(operations);
}

/**
 * The modpack IPC while the modpack services are off (degraded startup). Every
 * channel stays registered so the renderer never meets a missing handler:
 * get-state answers the unmanaged state of a server without modpack state, no
 * modpack job can be active, list-recovery lists the servers the startup
 * recovery gate blocks, and everything else is MODPACK_SERVICES_UNAVAILABLE.
 * @param {{readServerState?: (serverId: string) => unknown, listRecovery?: () => unknown}} options
 */
function createUnavailableModpackHandlers({ readServerState = null, listRecovery = null } = {}) {
  if ((readServerState !== null && typeof readServerState !== 'function') ||
      (listRecovery !== null && typeof listRecovery !== 'function')) throw invalid();
  return createChannelHandlers({
    'modpacks:get-state': request => {
      if (!readServerState) throw modpackServicesUnavailable();
      return readServerState(request.serverId);
    },
    'modpacks:get-active-jobs': request => ({ serverId: request.serverId, items: [] }),
    'modpacks:list-recovery': () => {
      // Without the gate's answer the blocked servers are unknown: refuse, so
      // the renderer keeps every start disabled.
      if (!listRecovery) throw modpackServicesUnavailable();
      return listRecovery();
    }
  }, () => { throw modpackServicesUnavailable(); });
}

module.exports = { createModpackHandlers, createUnavailableModpackHandlers, MODPACK_INVOKE_CHANNELS };
