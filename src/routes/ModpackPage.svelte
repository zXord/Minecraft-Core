<script>
  import { onDestroy, onMount, tick } from 'svelte';
  import { isPlanStaleError, ModpackApiError, modpackApi } from '../utils/modpacks/modpackApi.js';
  import { createServerRequestScope } from '../utils/modpacks/serverRequestScope.js';
  import { mergePublicJob } from '../utils/modpacks/publicJobMerge.js';
  import { projectVerificationAttempt, verificationSessionReferences } from '../utils/modpacks/verificationSession.js';
  import ModpackOverview from '../components/modpacks/ModpackOverview.svelte';
  import ClientCompanionPanel from '../components/modpacks/ClientCompanionPanel.svelte';
  import ModpackVersionPanel from '../components/modpacks/ModpackVersionPanel.svelte';
  import ModpackActionPanel from '../components/modpacks/ModpackActionPanel.svelte';
  import ModpackPlanReview from '../components/modpacks/ModpackPlanReview.svelte';
  import ModpackJobProgress from '../components/modpacks/ModpackJobProgress.svelte';
  import ModpackInspectionProgress from '../components/modpacks/ModpackInspectionProgress.svelte';
  import ModpackPlanningProgress from '../components/modpacks/ModpackPlanningProgress.svelte';
  import ModpackRecoveryPanel from '../components/modpacks/ModpackRecoveryPanel.svelte';
  import ModpackNotificationCenter from '../components/modpacks/ModpackNotificationCenter.svelte';
  import { filterRecoveryRecordsForServer } from '../stores/modpackNotificationStore.js';
  import { compareVersions } from '../utils/versionUtils.js';
  import ModpackSourceChoice from '../components/setup/ModpackSourceChoice.svelte';
  import ModrinthPackBrowser from '../components/setup/ModrinthPackBrowser.svelte';
  import GitHubReleasePicker from '../components/setup/GitHubReleasePicker.svelte';
  import GitHubAssetReview from '../components/setup/GitHubAssetReview.svelte';
  import ArchiveGuidedReview from '../components/setup/ArchiveGuidedReview.svelte';

  export let currentInstance;
  export let serverPath = '';
  export let navigationTarget = null;

  let state = null;
  let history = [];
  let historyCursor = null;
  let recovery = [];
  let stateStatus = 'unknown';
  let historyStatus = 'unknown';
  let recoveryStatus = 'unknown';
  let stateError = null;
  let historyError = null;
  let recoveryError = null;
  let recoveryAction = '';
  let recoveryActionError = null;
  let error = null;
  let activeSection = 'overview';
  let flow = 'dashboard';
  let operationKind = 'install-existing';
  let inspection = null;
  let selectedRequest = null;
  let reviewedPlan = null;
  let githubRelease = null;
  let githubAssets = null;
  let suggestedRepositoryUrl = '';
  let linkedModrinthProjectId = '';
  let currentGithubReleaseId = '';
  let approvedLinkedModrinthProjectId = null;
  let managedGithubChronologicalOperation = null;
  let requestedModrinthVersionId = '';
  let requestedModrinthNavigationToken = 0;
  let requestedGithubReleaseId = '';
  let requestedGithubNavigationToken = 0;
  let allowCurrentGithubReleaseReview = false;
  let job = null;
  let verificationAttempt = null;
  let verificationAttemptStatus = 'none';
  let verificationReference = null;
  let verificationRequestSequence = 0;
  let verificationInFlight = null;
  let busy = false;
  let checkingForUpdates = false;
  let updateCheckStatus = '';
  let cleanups = [];
  let selectedRestorePointId = null;
  let rollbackOptions = [];
  let rollbackOptionsLoading = false;
  let rollbackOptionsError = null;
  let rollbackOptionsRequestSequence = 0;
  let rollbackOptionsServerId = '';
  let handledNavigationToken = null;
  let pageRoot;
  let errorRegion;
  let focusedFlow = null;
  let focusedError = null;
  let contextualNotificationSequence = 0;
  let inspectionRequestSequence = 0;
  let activeInspectionRequestSequence = null;
  let inspectionProgress = null;
  let preflightProgress = null;
  let selectingDestination = false;
  let refreshRequestSequence = 0;
  let pageMounted = false;
  let activeInspectionController = null;
  let activeJobs = [];
  let activityStatus = 'unknown';
  let activityError = null;
  let activityRequestSequence = 0;
  let activityTimer = null;
  let outcomeActionSequence = 0;
  const serverRequestScope = createServerRequestScope();

  $: serverId = currentInstance?.type === 'server' ? currentInstance.id || '' : '';
  $: if (serverId !== serverRequestScope.serverId) activateServer(serverId);
  $: isManaged = Boolean(state?.modpackManaged);
  $: loading = [stateStatus, historyStatus, recoveryStatus].some(status => ['unknown', 'loading'].includes(status));
  $: lifecycleAvailable = stateStatus === 'ready' && historyStatus === 'ready' && recoveryStatus === 'ready' && activityStatus === 'ready' && activeJobs.length === 0 && !recoveryAction;
  $: recoveryItems = Array.isArray(recovery) ? recovery : recovery?.items || [];
  $: currentServerRecoveryItems = filterRecoveryRecordsForServer(recoveryItems, serverId);
  $: rememberOwnedJob(job);
  $: if (serverId !== rollbackOptionsServerId) {
    rollbackOptionsServerId = serverId;
    rollbackOptionsRequestSequence += 1;
    rollbackOptions = [];
    rollbackOptionsLoading = false;
    rollbackOptionsError = null;
  }
  $: if (!loading && navigationTarget?.token && navigationTarget.token !== handledNavigationToken) {
    applyNavigationTarget(navigationTarget);
  }
  $: if (flow !== focusedFlow) {
    focusedFlow = flow;
    focusStage(flow);
  }
  $: if (error && error !== focusedError) {
    focusedError = error;
    focusError(error);
  } else if (!error) {
    focusedError = null;
  }

  async function focusStage(expectedFlow) {
    await tick();
    if (flow !== expectedFlow || !pageRoot) return;
    const target = [...pageRoot.querySelectorAll('h2, h3')].find(element =>
      element.offsetParent !== null && !element.closest('[data-verification-history]'));
    if (!target) return;
    target.setAttribute('tabindex', '-1');
    target.focus();
  }

  async function focusError(expectedError) {
    await tick();
    if (error !== expectedError) return;
    errorRegion?.focus?.();
  }

  function activateServer(nextServerId) {
    const activation = serverRequestScope.activate(nextServerId);
    if (!activation.changed) return;
    invalidateInspectionRequests();
    refreshRequestSequence += 1;
    activityRequestSequence += 1;
    outcomeActionSequence += 1;
    if (activityTimer) clearTimeout(activityTimer);
    activityTimer = null;
    activeJobs = [];
    activityStatus = 'unknown';
    activityError = null;
    rollbackOptionsRequestSequence += 1;
    state = null;
    history = [];
    historyCursor = null;
    recovery = [];
    stateStatus = historyStatus = recoveryStatus = 'unknown';
    stateError = historyError = recoveryError = recoveryActionError = null;
    recoveryAction = '';
    error = null;
    activeSection = 'overview';
    flow = 'dashboard';
    operationKind = 'install-existing';
    const abandonedInspection = inspection;
    inspection = null;
    selectedRequest = null;
    void discardInspectionSession(abandonedInspection).catch(() => {});
    reviewedPlan = null;
    githubRelease = null;
    githubAssets = null;
    suggestedRepositoryUrl = '';
    linkedModrinthProjectId = '';
    currentGithubReleaseId = '';
    approvedLinkedModrinthProjectId = null;
    managedGithubChronologicalOperation = null;
    requestedModrinthVersionId = '';
    requestedModrinthNavigationToken = 0;
    requestedGithubReleaseId = '';
    requestedGithubNavigationToken = 0;
    allowCurrentGithubReleaseReview = false;
    job = null;
    invalidateVerificationRead();
    verificationAttempt = null;
    verificationAttemptStatus = 'none';
    verificationReference = null;
    busy = false;
    checkingForUpdates = false;
    updateCheckStatus = '';
    preflightProgress = null;
    selectingDestination = false;
    selectedRestorePointId = null;
    rollbackOptions = [];
    rollbackOptionsLoading = false;
    rollbackOptionsError = null;
    rollbackOptionsServerId = nextServerId;
    focusedFlow = null;
    focusedError = null;
    if (pageMounted && nextServerId) {
      void refresh(nextServerId);
      void hydrateVerificationAttempt();
    }
  }

  function currentServerRequest(token) {
    return serverRequestScope.isCurrent(token, serverId);
  }

  function invalidateVerificationRead() {
    verificationRequestSequence += 1;
    verificationInFlight = null;
  }

  async function hydrateVerificationAttempt() {
    if (!pageMounted || !serverId) return;
    const reference = verificationSessionReferences.get(serverId);
    if (!reference || verificationInFlight?.reference === reference) return;
    const token = serverRequestScope.begin();
    const sequence = ++verificationRequestSequence;
    const request = { reference, sequence };
    verificationInFlight = request;
    if (verificationReference !== reference) verificationAttempt = null;
    verificationReference = reference;
    verificationAttemptStatus = 'loading';
    const isCurrent = () => pageMounted && currentServerRequest(token) && sequence === verificationRequestSequence &&
      verificationSessionReferences.get(token.serverId) === reference;
    try {
      const value = await modpackApi.getJob(reference.jobId);
      if (!isCurrent()) return;
      verificationAttempt = projectVerificationAttempt(value, reference);
      verificationAttemptStatus = verificationAttempt ? 'ready' : 'unavailable';
    } catch {
      if (!isCurrent()) return;
      verificationAttempt = null;
      verificationAttemptStatus = 'unavailable';
    } finally {
      if (verificationInFlight === request) verificationInFlight = null;
    }
  }

  function publishVerificationAttempt(value) {
    if (!pageMounted || !serverId) return;
    const reference = verificationSessionReferences.get(serverId);
    if (!reference || value?.jobId !== reference.jobId) return;
    invalidateVerificationRead();
    verificationReference = reference;
    verificationAttempt = projectVerificationAttempt(value, reference);
    verificationAttemptStatus = verificationAttempt ? 'ready' : 'unavailable';
  }

  function verificationCount(value) { return BigInt(value).toLocaleString('en-US'); }

  function rememberOwnedJob(value) {
    if (!value?.jobId || !activeJobs.some(item => item.job.jobId === value.jobId)) return;
    activeJobs = activeJobs.map(item => item.job.jobId === value.jobId
      ? { ...item, job: mergePublicJob(item.job, value, { durable: true }) } : item);
  }

  function setSelectedJob(value) {
    rememberOwnedJob(job);
    if (job?.jobId !== value?.jobId) outcomeActionSequence += 1;
    job = value;
  }

  function selectOwnedJob(jobId) {
    rememberOwnedJob(job);
    const item = activeJobs.find(value => value.job.jobId === jobId);
    if (!item) return;
    if (job?.jobId !== jobId) invalidateVerificationRead();
    if (item.job.operationKind === 'verify' && projectVerificationAttempt(item.job, { serverId, jobId })) {
      const recorded = verificationSessionReferences.record(serverId, jobId);
      if (recorded.changed || verificationReference !== recorded.reference) {
        invalidateVerificationRead();
        verificationReference = recorded.reference;
        verificationAttempt = null;
        void hydrateVerificationAttempt();
      }
    }
    if (verificationAttemptStatus === 'loading') void hydrateVerificationAttempt();
    setSelectedJob(job?.jobId === jobId ? mergePublicJob(job, item.job, { durable: true }) : item.job);
    flow = 'job';
  }

  async function discoverActiveJobs() {
    const token = serverRequestScope.begin();
    const generation = ++activityRequestSequence;
    if (activityTimer) clearTimeout(activityTimer);
    activityTimer = null;
    if (!pageMounted || !token.serverId) return;
    if (activityStatus === 'unknown') activityStatus = 'loading';
    const isCurrent = () => pageMounted && currentServerRequest(token) && generation === activityRequestSequence;
    try {
      const result = await modpackApi.getActiveJobs(token.serverId);
      if (!isCurrent()) return;
      if (result?.serverId !== token.serverId || !Array.isArray(result.items)) throw new Error('Operation status unavailable');
      const previouslyOwned = activeJobs.length > 0;
      const previousJobs = new Map(activeJobs.map(item => [item.job.jobId, item.job]));
      activeJobs = result.items.map(item => {
        let current = mergePublicJob(previousJobs.get(item.job.jobId), item.job, { durable: true });
        if (current.jobId === job?.jobId) current = mergePublicJob(current, job, { durable: true });
        return { ...item, job: current };
      });
      activityStatus = 'ready';
      activityError = null;
      if (activeJobs.length === 1) {
        const discovered = activeJobs[0].job;
        setSelectedJob(job?.jobId === discovered.jobId ? mergePublicJob(job, discovered, { durable: true }) : discovered);
        flow = 'job';
      } else if (activeJobs.length > 1 && !activeJobs.some(item => item.job.jobId === job?.jobId)) {
        setSelectedJob(null);
        flow = 'owned-jobs';
      }
      if (previouslyOwned && activeJobs.length === 0) {
        void refresh(token.serverId);
        void hydrateVerificationAttempt();
      }
    } catch (caught) {
      if (!isCurrent()) return;
      activityStatus = 'error';
      activityError = caught;
    } finally {
      if (isCurrent() && activeJobs.length > 0) activityTimer = setTimeout(discoverActiveJobs, 1200);
    }
  }

  function invalidateInspectionRequests() {
    activeInspectionController?.abort();
    activeInspectionController = null;
    inspectionRequestSequence += 1;
    if (activeInspectionRequestSequence !== null) {
      activeInspectionRequestSequence = null;
      busy = false;
    }
    inspectionProgress = null;
  }

  function discardInspectionSession(value = inspection) {
    const inspectionId = value?.inspectionId;
    if (value === inspection) inspection = null;
    if (!inspectionId) return Promise.resolve(false);
    return modpackApi.discardInspection(inspectionId);
  }

  function beginInspectionRequest() {
    activeInspectionController?.abort();
    const controller = new AbortController();
    const requestSequence = ++inspectionRequestSequence;
    activeInspectionRequestSequence = requestSequence;
    activeInspectionController = controller;
    busy = true;
    error = null;
    inspectionProgress = { phase: 'resolving' };
    return { requestSequence, signal: controller.signal };
  }

  function finishInspectionRequest(request) {
    const requestSequence = request.requestSequence;
    if (requestSequence !== inspectionRequestSequence) return;
    activeInspectionRequestSequence = null;
    activeInspectionController = null;
    busy = false;
    inspectionProgress = null;
  }

  function navigateSelectionFlow(nextFlow) {
    invalidateInspectionRequests();
    flow = nextFlow;
  }

  function abandonInspection(nextFlow = 'source') {
    invalidateInspectionRequests();
    const abandonedInspection = inspection;
    inspection = null;
    selectedRequest = null;
    reviewedPlan = null;
    void discardInspectionSession(abandonedInspection).catch(() => {});
    flow = nextFlow;
  }

  function selectDashboardSection(section) {
    invalidateInspectionRequests();
    activeSection = section;
  }

  function navigationFailure(message) {
    const value = new Error(message);
    value.code = 'PLAN_STALE';
    return value;
  }

  function exactReleaseTarget(value) {
    const keys = value && typeof value === 'object' && !Array.isArray(value) ? Object.keys(value) : [];
    const identifier = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,191}$/;
    if (keys.length !== 5 || !['serverId', 'provider', 'sourceId', 'releaseId', 'prerelease'].every(key => keys.includes(key)) ||
        !['github', 'modrinth'].includes(value.provider) || typeof value.prerelease !== 'boolean' ||
        !identifier.test(value.serverId) || !identifier.test(value.sourceId) || !identifier.test(value.releaseId)) {
      throw navigationFailure('The exact release target from this notification is invalid. Refresh notification history before retrying.');
    }
    return value;
  }

  function clearRequestedReleaseTargets() {
    requestedModrinthVersionId = '';
    requestedGithubReleaseId = '';
    allowCurrentGithubReleaseReview = false;
  }

  function applyExactReleaseTarget(target, destination) {
    if (!lifecycleAvailable) {
      error = navigationFailure('Lifecycle status is unavailable. Retry the status reads before reviewing a release.');
      return;
    }
    let releaseTarget;
    try {
      releaseTarget = exactReleaseTarget(destination.releaseTarget);
    } catch (caught) {
      error = caught;
      return;
    }
    const source = state?.source;
    const currentSourceId = source?.provider === 'github' ? source.repositoryId : source?.projectId;
    if (!isManaged || releaseTarget.serverId !== serverId || source?.provider !== releaseTarget.provider ||
        currentSourceId !== releaseTarget.sourceId) {
      error = navigationFailure('This release notification no longer matches the server’s managed modpack source. Minecraft Core did not open or substitute another release.');
      return;
    }

    invalidateInspectionRequests();
    inspection = null;
    selectedRequest = null;
    reviewedPlan = null;
    githubRelease = null;
    githubAssets = null;
    operationKind = 'update';
    clearRequestedReleaseTargets();
    if (releaseTarget.provider === 'modrinth') {
      requestedModrinthVersionId = releaseTarget.releaseId;
      requestedModrinthNavigationToken = target.token;
      flow = 'dashboard';
      activeSection = 'versions';
      return;
    }

    const owner = source?.githubOwner;
    const repo = source?.githubRepo;
    if (!/^[A-Za-z0-9](?:[A-Za-z0-9-]{0,38})$/.test(owner || '') ||
        !/^(?!\.)(?!.*\.git$)[A-Za-z0-9_.-]{1,100}$/i.test(repo || '') || !source?.releaseId) {
      error = navigationFailure('Minecraft Core does not have the trusted GitHub identity required to open this exact release.');
      return;
    }
    suggestedRepositoryUrl = `https://github.com/${owner}/${repo}`;
    linkedModrinthProjectId = '';
    currentGithubReleaseId = source.releaseId;
    approvedLinkedModrinthProjectId = null;
    managedGithubChronologicalOperation = null;
    requestedGithubReleaseId = releaseTarget.releaseId;
    requestedGithubNavigationToken = target.token;
    allowCurrentGithubReleaseReview = target.notificationType === 'source-changed' &&
      releaseTarget.releaseId === source.releaseId;
    flow = 'github';
  }

  function applyNavigationTarget(target) {
    handledNavigationToken = target.token;
    if (target.serverId && serverId && target.serverId !== serverId) return;
    invalidateInspectionRequests();
    const type = target.notificationType;
    const destination = target.result?.destination;
    const destinationKind = destination?.kind || '';
    flow = 'dashboard';
    error = null;
    if (destination?.releaseTarget) {
      applyExactReleaseTarget(target, destination);
      return;
    }
    if (['update-available', 'prerelease-available', 'github-asset-selection-required', 'source-changed'].includes(type) ||
        ['selection', 'asset-selection'].includes(destinationKind)) {
      activeSection = 'versions';
    } else if (type === 'recovery-required' || destinationKind === 'recovery') {
      activeSection = 'recovery';
    } else if (destinationKind === 'restore-point') {
      activeSection = 'history';
    } else if (type === 'integrity-warning') {
      activeSection = 'actions';
    } else {
      activeSection = 'overview';
    }
  }

  function handleContextualNotificationNavigation(event) {
    contextualNotificationSequence += 1;
    applyNavigationTarget({
      token: `contextual-${contextualNotificationSequence}`,
      ...event.detail
    });
  }

  async function refresh(requestedServerId = serverId, afterRecovery = false) {
    if (!requestedServerId || requestedServerId !== serverRequestScope.serverId || (recoveryAction && !afterRecovery)) return;
    const requestToken = serverRequestScope.begin();
    const requestSequence = ++refreshRequestSequence;
    void discoverActiveJobs();
    stateStatus = historyStatus = recoveryStatus = 'loading';
    const isCurrent = () => pageMounted && currentServerRequest(requestToken) && requestSequence === refreshRequestSequence;
    const reads = [
      modpackApi.getState(requestedServerId).then(value => {
        if (!isCurrent()) return;
        state = value;
        stateStatus = 'ready';
        stateError = null;
      }, caught => {
        if (!isCurrent()) return;
        stateStatus = 'error';
        stateError = caught;
      }),
      modpackApi.listHistory(requestedServerId, null, 50).then(value => {
        if (!isCurrent()) return;
        history = value?.items || [];
        historyCursor = value?.nextCursor || null;
        historyStatus = 'ready';
        historyError = null;
      }, caught => {
        if (!isCurrent()) return;
        historyStatus = 'error';
        historyError = caught;
      }),
      modpackApi.listRecovery().then(value => {
        if (!isCurrent()) return;
        recovery = value || [];
        recoveryStatus = 'ready';
        recoveryError = null;
        recoveryActionError = null;
      }, caught => {
        if (!isCurrent()) return;
        recoveryStatus = 'error';
        recoveryError = caught;
      })
    ];
    // Recovery controls need only the action's fresh recovery settlement.
    // Canonical reads keep publishing independently through their guarded handlers.
    await (afterRecovery ? reads[2] : Promise.all(reads));
  }

  async function recoverRecord(record, actionId) {
    if (recoveryAction || recoveryStatus !== 'ready' ||
        !currentServerRecoveryItems.some(item => item.recoveryId === record.recoveryId && item.actions?.some(action => action.actionId === actionId))) return;
    const requestToken = serverRequestScope.begin();
    recoveryAction = `${record.recoveryId}:${actionId}`;
    recoveryActionError = null;
    try {
      await modpackApi.recover(record.recoveryId, actionId);
      if (!pageMounted || !currentServerRequest(requestToken)) return;
      // Action success does not replace a fresh current-server recovery read.
      await refresh(requestToken.serverId, true);
    } catch (caught) {
      if (pageMounted && currentServerRequest(requestToken)) recoveryActionError = caught;
    } finally {
      if (pageMounted && currentServerRequest(requestToken)) recoveryAction = '';
    }
  }

  async function loadOlderHistory() {
    if (!historyCursor || historyStatus !== 'ready') return;
    const requestToken = serverRequestScope.begin();
    const requestSequence = refreshRequestSequence;
    const requestedCursor = historyCursor;
    busy = true;
    try {
      const page = await modpackApi.listHistory(requestToken.serverId, requestedCursor, 50);
      if (!currentServerRequest(requestToken)) return;
      if (requestSequence !== refreshRequestSequence) return;
      history = [...history, ...(page?.items || [])];
      historyCursor = page?.nextCursor || null;
    } catch (caught) {
      if (!currentServerRequest(requestToken) || requestSequence !== refreshRequestSequence) return;
      error = caught;
    } finally {
      if (currentServerRequest(requestToken)) busy = false;
    }
  }

  function beginSource(kind = isManaged ? 'switch' : 'install-existing') {
    if (!lifecycleAvailable) return;
    if (kind === 'repair' && (!isManaged || busy)) return;
    invalidateVerificationRead();
    invalidateInspectionRequests();
    operationKind = kind;
    const abandonedInspection = inspection;
    inspection = null;
    selectedRequest = null;
    void discardInspectionSession(abandonedInspection).catch(() => {});
    reviewedPlan = null;
    error = null;
    suggestedRepositoryUrl = '';
    linkedModrinthProjectId = '';
    currentGithubReleaseId = '';
    approvedLinkedModrinthProjectId = null;
    managedGithubChronologicalOperation = null;
    clearRequestedReleaseTargets();
    flow = 'source';
    if (verificationAttemptStatus === 'loading') void hydrateVerificationAttempt();
  }

  async function checkForModpackUpdates() {
    if (!lifecycleAvailable || checkingForUpdates || !isManaged || !serverId || !['github', 'modrinth'].includes(state?.source?.provider)) return;
    const requestToken = serverRequestScope.begin();
    checkingForUpdates = true;
    updateCheckStatus = '';
    error = null;
    try {
      const results = await modpackApi.checkUpdates(null, true);
      if (!currentServerRequest(requestToken)) return;
      const checked = Array.isArray(results) ? results : [];
      updateCheckStatus = checked.some(result => typeof result?.errorCode === 'string')
        ? 'Release check finished with an error. Review notifications for the retry action.'
        : checked.some(result => result?.changed === true)
          ? 'Release check finished. A matching update is available in notifications.'
          : 'Release check finished. No newer matching release was found.';
    } catch (caught) {
      if (!currentServerRequest(requestToken)) return;
      error = caught;
      updateCheckStatus = 'The release check could not be completed.';
    } finally {
      if (currentServerRequest(requestToken)) checkingForUpdates = false;
    }
  }

  async function loadRollbackOptions() {
    const requestedServerId = serverId;
    const requestSequence = ++rollbackOptionsRequestSequence;
    rollbackOptions = [];
    rollbackOptionsLoading = true;
    rollbackOptionsError = null;
    try {
      const result = await modpackApi.listRollbackOptions(requestedServerId);
      if (requestSequence !== rollbackOptionsRequestSequence || serverId !== requestedServerId || flow !== 'restore-points') return;
      rollbackOptions = Array.isArray(result?.items) ? result.items : [];
    } catch (caught) {
      if (requestSequence !== rollbackOptionsRequestSequence || serverId !== requestedServerId || flow !== 'restore-points') return;
      rollbackOptionsError = caught;
    } finally {
      if (requestSequence === rollbackOptionsRequestSequence && serverId === requestedServerId) {
        rollbackOptionsLoading = false;
      }
    }
  }

  function reviewLinkedGithub(event) {
    invalidateInspectionRequests();
    suggestedRepositoryUrl = event.detail.repositoryUrl;
    linkedModrinthProjectId = event.detail.modrinthProjectId;
    currentGithubReleaseId = '';
    approvedLinkedModrinthProjectId = null;
    managedGithubChronologicalOperation = null;
    clearRequestedReleaseTargets();
    flow = 'github';
  }

  function reviewManagedGithub(event) {
    if (!lifecycleAvailable) return;
    invalidateInspectionRequests();
    suggestedRepositoryUrl = event.detail.repositoryUrl;
    linkedModrinthProjectId = '';
    currentGithubReleaseId = event.detail.currentReleaseId;
    approvedLinkedModrinthProjectId = null;
    managedGithubChronologicalOperation = null;
    clearRequestedReleaseTargets();
    flow = 'github';
  }

  function handleGithubAssets(event) {
    invalidateInspectionRequests();
    githubRelease = event.detail.release;
    githubAssets = event.detail.assets;
    approvedLinkedModrinthProjectId = event.detail.linkedModrinthProjectId || null;
    managedGithubChronologicalOperation = event.detail.operationKind || null;
    if (event.detail.operationKind && operationKind !== 'repair') operationKind = event.detail.operationKind;
    // The exact notification target is one-shot, including across picker remounts.
    clearRequestedReleaseTargets();
    flow = 'github-assets';
  }

  function inspectGithubSelection(event) {
    const classifyManagedRuntime = Boolean(currentGithubReleaseId) && operationKind !== 'repair' &&
      ['update', 'downgrade'].includes(managedGithubChronologicalOperation);
    return inspectSelection({
      ...event.detail.request,
      rememberAssetPattern: Boolean(event.detail.rememberPattern),
      ...(approvedLinkedModrinthProjectId ? { linkedModrinthProjectId: approvedLinkedModrinthProjectId } : {})
    }, classifyManagedRuntime ? managedGithubChronologicalOperation : operationKind, classifyManagedRuntime);
  }

  async function selectLocalArchive() {
    if (busy || !lifecycleAvailable) return;
    const requestedOperationKind = operationKind;
    const inspectionRequest = beginInspectionRequest();
    const { requestSequence } = inspectionRequest;
    try {
      const selection = await modpackApi.selectLocalArchive(true);
      if (requestSequence !== inspectionRequestSequence) return;
      if (selection?.selectionId) await inspectSelection({ provider: 'local', selectionId: selection.selectionId }, requestedOperationKind, false, true);
    } catch (caught) {
      if (requestSequence !== inspectionRequestSequence) return;
      error = caught;
    } finally {
      finishInspectionRequest(inspectionRequest);
    }
  }

  function classifyExactManagedRuntime(chronologicalOperation, targetRuntime) {
    if (chronologicalOperation === 'downgrade') return 'downgrade';
    const currentRuntime = state?.runtime;
    if (!targetRuntime?.minecraftVersion || !targetRuntime?.loaderFamily || !targetRuntime?.loaderVersion ||
        !currentRuntime?.minecraftVersion || !currentRuntime?.loaderFamily || !currentRuntime?.loaderVersion) return 'downgrade';
    const minecraftComparison = compareVersions(targetRuntime.minecraftVersion, currentRuntime.minecraftVersion);
    if (minecraftComparison < 0) return 'downgrade';
    if (minecraftComparison > 0 || targetRuntime.loaderFamily !== currentRuntime.loaderFamily) return 'switch';
    return compareVersions(targetRuntime.loaderVersion, currentRuntime.loaderVersion) < 0 ? 'downgrade' : 'update';
  }

  async function inspectSelection(request, forcedOperation = null, classifyManagedRuntime = false, allowBusy = false) {
    if (!lifecycleAvailable) return;
    if (busy && !allowBusy) return;
    const requestedSelection = {
      ...request,
      ...(Array.isArray(request?.assetIds) ? { assetIds: [...request.assetIds] } : {})
    };
    const inspectionRequest = beginInspectionRequest();
    const { requestSequence } = inspectionRequest;
    const requestedOperationKind = forcedOperation || operationKind;
    try {
      const nextInspection = await modpackApi.inspect(requestedSelection, progress => {
        if (requestSequence === inspectionRequestSequence) inspectionProgress = progress;
      }, { signal: inspectionRequest.signal });
      if (requestSequence !== inspectionRequestSequence) return;
      if (inspection?.inspectionId && inspection.inspectionId !== nextInspection?.inspectionId) {
        await discardInspectionSession(inspection);
        if (requestSequence !== inspectionRequestSequence) return;
      }
      selectedRequest = requestedSelection;
      inspection = nextInspection;
      operationKind = classifyManagedRuntime
        ? classifyExactManagedRuntime(requestedOperationKind, nextInspection?.classification?.runtime)
        : requestedOperationKind;
      reviewedPlan = null;
      flow = 'inspection';
    } catch (caught) {
      if (requestSequence !== inspectionRequestSequence) return;
      error = caught;
    } finally {
      finishInspectionRequest(inspectionRequest);
    }
  }

  async function buildPreflight(event, kind = operationKind) {
    if (!lifecycleAvailable) return;
    const requestToken = serverRequestScope.begin();
    const requestedInspectionId = inspection?.inspectionId;
    if (!requestedInspectionId) return;
    busy = true;
    error = null;
    selectingDestination = false;
    preflightProgress = { phase: 'validating-destination', percent: 0 };
    try {
      const nextPlan = await modpackApi.preflight({
        inspectionId: requestedInspectionId,
        instanceId: requestToken.serverId,
        operationKind: kind,
        selections: event?.detail?.selections || {
          optionalFileIds: [], conflictChoices: {}, acknowledgeMissingProviderDigest: false,
          acknowledgeDowngradeWorldRisk: false, selectedRoot: null, runtimeChoice: null, maxRam: null
        }
      }, progress => {
        if (!currentServerRequest(requestToken)) return;
        preflightProgress = progress;
      });
      if (!currentServerRequest(requestToken)) return;
      reviewedPlan = nextPlan;
      flow = reviewedPlan?.requiresConflictReview === true ? 'inspection' : 'review';
      if (flow === 'review') inspection = null;
    } catch (caught) {
      if (!currentServerRequest(requestToken)) return;
      error = caught;
    } finally {
      if (currentServerRequest(requestToken)) {
        selectingDestination = false;
        preflightProgress = null;
        busy = false;
      }
    }
  }

  async function beginManagedOperation(kind) {
    if (!lifecycleAvailable) return;
    selectedRequest = null;
    operationKind = kind;
    error = null;
    if (kind === 'rollback-restore-point') {
      selectedRestorePointId = null;
      flow = 'restore-points';
      await loadRollbackOptions();
      return;
    }
    rollbackOptionsRequestSequence += 1;
    await buildManagementPlan(kind, null);
  }

  async function buildManagementPlan(kind, selectionRef) {
    if (!lifecycleAvailable) return;
    const requestToken = serverRequestScope.begin();
    busy = true;
    error = null;
    selectedRestorePointId = kind === 'rollback-restore-point' ? selectionRef : null;
    preflightProgress = { phase: 'scanning-server' };
    try {
      const nextPlan = await modpackApi.preflightManagement(
        requestToken.serverId,
        kind,
        selectionRef,
        progress => {
          if (!currentServerRequest(requestToken)) return;
          preflightProgress = progress;
        }
      );
      if (!currentServerRequest(requestToken)) return;
      reviewedPlan = nextPlan;
      operationKind = kind;
      flow = 'review';
    } catch (caught) {
      if (!currentServerRequest(requestToken)) return;
      error = isPlanStaleError(caught)
        ? new ModpackApiError({
          code: 'PLAN_STALE',
          message: 'The server changed while this preflight was being built. Run the action again to generate and review a fresh plan. Nothing was changed on the server.',
          details: caught.details,
          retryable: caught.retryable
        })
        : caught;
    } finally {
      if (currentServerRequest(requestToken)) {
        preflightProgress = null;
        busy = false;
      }
    }
  }

  async function refreshStaleReview() {
    const requestedSelection = selectedRequest ? {
      ...selectedRequest,
      ...(Array.isArray(selectedRequest.assetIds) ? { assetIds: [...selectedRequest.assetIds] } : {})
    } : null;
    const requestedOperationKind = operationKind;
    reviewedPlan = null;
    error = null;

    if (!requestedSelection) {
      if (requestedOperationKind === 'rollback-restore-point') flow = 'restore-points';
      else {
        flow = 'dashboard';
        activeSection = 'actions';
      }
      await buildManagementPlan(operationKind, selectedRestorePointId);
      return;
    }

    const staleInspection = inspection;
    inspection = null;
    if (staleInspection?.inspectionId) {
      busy = true;
      try {
        await discardInspectionSession(staleInspection);
      } catch (caught) {
        error = caught;
        busy = false;
        return;
      }
      busy = false;
    }

    if (requestedSelection?.provider === 'local') {
      selectedRequest = null;
      flow = 'source';
      error = new ModpackApiError({
        code: 'PLAN_STALE',
        message: 'The reviewed plan expired. Select the local archive again and run a fresh preflight review. Nothing was changed on the server.'
      });
      return;
    }

    flow = 'source';
    await inspectSelection(requestedSelection, requestedOperationKind);
  }

  async function verifyModpack() {
    if (!lifecycleAvailable || busy) return;
    const requestToken = serverRequestScope.begin();
    invalidateVerificationRead();
    busy = true;
    error = null;
    try {
      const nextVerification = await modpackApi.verify(requestToken.serverId);
      if (!pageMounted || !currentServerRequest(requestToken)) return;
      const jobId = Object.getOwnPropertyDescriptor(nextVerification || {}, 'jobId')?.value;
      if (!projectVerificationAttempt(nextVerification, { serverId: requestToken.serverId, jobId })) {
        throw new Error('The verification response is unavailable. Check active operations before trying again.');
      }
      verificationSessionReferences.record(requestToken.serverId, jobId);
      publishVerificationAttempt(nextVerification);
      setSelectedJob(nextVerification);
      flow = 'job';
      void discoverActiveJobs();
    } catch (caught) {
      if (!pageMounted || !currentServerRequest(requestToken)) return;
      error = caught;
      if (verificationAttemptStatus === 'loading') void hydrateVerificationAttempt();
    } finally {
      if (pageMounted && currentServerRequest(requestToken)) busy = false;
    }
  }

  function handleStarted(event) {
    invalidateVerificationRead();
    setSelectedJob(event.detail.job);
    flow = 'job';
    void hydrateVerificationAttempt();
    void discoverActiveJobs();
  }

  async function handleOutcomeAction(event) {
    const value = event.detail.value;
    if (value?.type !== 'outcome-action-result') return;
    const originJobId = event.detail.job?.jobId;
    if (!pageMounted || !originJobId || originJobId !== job?.jobId) return;
    const requestToken = serverRequestScope.begin();
    const sequence = ++outcomeActionSequence;
    const isCurrent = () => pageMounted && currentServerRequest(requestToken) &&
      sequence === outcomeActionSequence && job?.jobId === originJobId;
    const destination = value?.destination;
    if (!destination && !value?.operationRef) {
      if (['removed', 'retained'].includes(value?.status)) await refresh();
      return;
    }

    if (value.operationRef) {
      if (event.detail.actionId === 'retry') {
        try {
          const resultJob = await modpackApi.getJob(value.operationRef);
          if (!isCurrent()) return;
          setSelectedJob(resultJob);
          flow = 'job';
        } catch (caught) {
          if (isCurrent()) error = caught;
        }
      } else {
        flow = 'dashboard';
        activeSection = 'recovery';
        setSelectedJob(null);
        await refresh();
      }
      return;
    }

    if (['selection', 'asset-selection'].includes(destination.kind)) {
      beginSource();
      return;
    }

    flow = 'dashboard';
    invalidateInspectionRequests();
    reviewedPlan = null;
    inspection = null;
    selectedRequest = null;
    setSelectedJob(null);
    if (destination.kind === 'details' || destination.kind === 'restore-point') activeSection = 'history';
    else if (destination.kind === 'recovery') activeSection = 'recovery';
    else if (destination.kind === 'server') activeSection = 'overview';
    else return;
    await refresh();
  }

  function returnToDashboard() {
    invalidateInspectionRequests();
    rollbackOptionsRequestSequence += 1;
    rollbackOptionsLoading = false;
    rollbackOptionsError = null;
    flow = 'dashboard';
    reviewedPlan = null;
    const abandonedInspection = inspection;
    inspection = null;
    selectedRequest = null;
    void discardInspectionSession(abandonedInspection).catch(() => {});
    // Keep the final job summary available while refreshing current authority.
    refresh();
  }

  onMount(() => {
    pageMounted = true;
    cleanups = [modpackApi.onStateChanged(event => {
      if (event?.instanceId === serverId || event?.serverId === serverId) refresh();
    }), modpackApi.onJobProgress(event => {
      if (!pageMounted || event?.serverId !== serverId) return;
      activeJobs = activeJobs.map(item => item.job.jobId === event.jobId
        ? { ...item, job: mergePublicJob(item.job, event) } : item);
      if (event.jobId === job?.jobId) job = mergePublicJob(job, event);
      void discoverActiveJobs();
    })];
    if (serverId) {
      void refresh(serverId);
      void hydrateVerificationAttempt();
    }
  });
  onDestroy(() => {
    pageMounted = false;
    invalidateVerificationRead();
    refreshRequestSequence += 1;
    activityRequestSequence += 1;
    outcomeActionSequence += 1;
    if (activityTimer) clearTimeout(activityTimer);
    invalidateInspectionRequests();
    const abandonedInspection = inspection;
    inspection = null;
    void discardInspectionSession(abandonedInspection).catch(() => {});
    rollbackOptionsRequestSequence += 1;
    cleanups.forEach(cleanup => cleanup());
  });
</script>

<div class="modpack-surface modpack-page mp-stack" bind:this={pageRoot}>
  <header class="page-header mp-toolbar">
    <div class="grow"><p class="mp-kicker">Server lifecycle</p><h1 class="mp-title">Modpack</h1><p class="mp-subtitle">Install, verify, update, downgrade, switch, repair, roll back, detach, or uninstall with reviewed durable transactions.</p></div>
    <div class="page-actions">
      {#if flow !== 'dashboard'}
        <button class="mp-button" type="button" on:click={returnToDashboard}>Back to Modpack overview</button>
      {/if}
      {#if isManaged && ['github', 'modrinth'].includes(state?.source?.provider)}
        <button class="mp-button" type="button" disabled={checkingForUpdates || !lifecycleAvailable} on:click={checkForModpackUpdates}>{checkingForUpdates ? 'Checking for updates…' : 'Check for updates'}</button>
        <span class="mp-sr-only" role="status" aria-label="Release check status" aria-live="polite">{updateCheckStatus}</span>
      {/if}
      <ModpackNotificationCenter
        variant="contextual"
        {serverId}
        managed={isManaged}
        recoveryCount={currentServerRecoveryItems.length}
        connectStore={false}
        on:navigate={handleContextualNotificationNavigation}
      />
    </div>
  </header>

  {#if error}<section class="mp-state error page-error" bind:this={errorRegion} tabindex="-1" aria-live="assertive"><strong>{error.code || 'Modpack action unavailable'}</strong><p>{error.message}</p><button class="mp-button" type="button" on:click={() => (error = null)}>Dismiss</button></section>{/if}

  {#if verificationReference}
    <section class="mp-panel mp-stack" data-verification-history aria-label={verificationAttempt?.status === 'completed' ? 'Last verification' : 'Last verification attempt'}>
      <h2>{verificationAttempt?.status === 'completed' ? 'Last verification' : 'Last verification attempt'}</h2>
      <p>Job {verificationReference.jobId}</p>
      {#if verificationAttemptStatus === 'loading'}
        <p>Loading historical verification evidence…</p>
      {:else if verificationAttemptStatus === 'unavailable'}
        <p>Historical verification evidence is unavailable. No integrity result can be inferred.</p>
        <button class="mp-button" type="button" on:click={hydrateVerificationAttempt}>Retry historical read</button>
      {:else if verificationAttempt?.status === 'completed'}
        <p>Verified at <time datetime={verificationAttempt.verifiedAt}>{verificationAttempt.verifiedAt}</time> · revision {verificationAttempt.contentRevision}</p>
        <p>Then observed: {verificationCount(verificationAttempt.checkedFiles)} checked files · {verificationCount(verificationAttempt.mismatchCount)} differences</p>
        {#if verificationAttempt.healthy}<p>The checked content was healthy at verification time.</p>{/if}
        {#if verificationAttempt.mismatches.length}
          <ul aria-label="Historical managed file differences">{#each verificationAttempt.mismatches as mismatch}<li>{mismatch.entryName} — {mismatch.status} ({mismatch.origin} · {mismatch.role})</li>{/each}</ul>
        {/if}
        {#if verificationAttempt.mismatchesTruncated}<p>Showing {verificationAttempt.shownMismatchCount} differences; {verificationAttempt.omittedMismatchCount} additional differences are not listed.</p>{/if}
      {:else if verificationAttempt?.status === 'in-progress'}
        <p>This verification attempt had not completed when read. Current operation ownership is checked separately.</p>
      {:else if verificationAttempt}
        <p>Last verification attempt — {['failed', 'cancelled'].includes(verificationAttempt.status) ? verificationAttempt.status : 'did not complete'} at <time datetime={verificationAttempt.terminalAt}>{verificationAttempt.terminalAt}</time>. No successful integrity result is available for this attempt.</p>
      {/if}
      <p class="mp-muted">This is a historical observation, not a current integrity check. Review repair checks the installed source and current files again before any change.</p>
    </section>
  {/if}

  {#if activityStatus !== 'ready'}<section class="mp-panel mp-state" aria-live="polite"><strong>{activityStatus === 'error' ? 'Operation status unavailable' : 'Checking active operations…'}</strong><p>Operation ownership must be checked before new changes can start.</p>{#if activityError}<p>{activityError.message}</p>{/if}<button class="mp-button" type="button" on:click={discoverActiveJobs}>Retry operation status</button></section>{/if}
  {#if activeJobs.length > 1}<section class="mp-panel mp-stack" aria-label="Owned operations"><h2>Choose an owned operation</h2><p>Multiple operations are owned by this process. New changes remain blocked.</p>{#each activeJobs as item (item.job.jobId)}<button class="mp-button" type="button" on:click={() => selectOwnedJob(item.job.jobId)}>{item.job.operationKind} · {item.job.jobId} · {item.ownership}</button>{/each}</section>{/if}
  {#if activeJobs.length === 0 && activeSection !== 'recovery' && (recoveryStatus !== 'ready' || currentServerRecoveryItems.length > 0)}<ModpackRecoveryPanel {serverId} records={currentServerRecoveryItems} status={recoveryStatus} loadError={recoveryError} actionError={recoveryActionError} pendingAction={recoveryAction} onRefresh={() => refresh()} onRecover={recoverRecord} />{/if}

  {#if busy && preflightProgress && flow !== 'inspection'}
    <ModpackPlanningProgress progress={preflightProgress} />
  {/if}

  {#if flow === 'dashboard'}
    <nav class="section-tabs" aria-label="Modpack sections">
      {#each ['overview', 'versions', 'actions', 'history', 'recovery'] as section (section)}<button type="button" class:active={activeSection === section} aria-current={activeSection === section ? 'page' : undefined} on:click={() => selectDashboardSection(section)}>{section === 'overview' ? 'Overview' : section === 'versions' ? 'Versions' : section === 'actions' ? 'Actions' : section === 'history' ? 'History' : 'Recovery'}</button>{/each}
    </nav>
    {#if activeSection === 'overview'}<ModpackOverview {state} status={stateStatus} loadError={stateError} actionsAvailable={lifecycleAvailable} on:retry={() => refresh()} on:install={() => beginSource('install-existing')} on:filesonly={() => beginSource('import-files-only-new')} />
      {#if isManaged && lifecycleAvailable}{#key `${serverId}:${JSON.stringify(state?.source)}:${JSON.stringify(state?.runtime)}:${JSON.stringify(state?.selectedOptionalFiles)}`}<ClientCompanionPanel {serverId} managed={true} localArchive={state?.source?.provider === 'local'} />{/key}{/if}
    {:else if ['versions', 'actions'].includes(activeSection) && !lifecycleAvailable}
      <section class="mp-panel mp-state" aria-live="polite"><strong>{stateStatus === 'ready' ? 'Lifecycle actions unavailable' : stateStatus === 'error' ? 'Modpack state unavailable' : 'Loading managed modpack state…'}</strong><p>Current state, history, and recovery must be checked successfully before lifecycle actions can be reviewed.</p><button class="mp-button" type="button" on:click={() => refresh()} disabled={loading || Boolean(recoveryAction)}>Retry status reads</button></section>
    {:else if activeSection === 'versions'}<ModpackVersionPanel {state} requestedVersionId={requestedModrinthVersionId} requestedNavigationToken={requestedModrinthNavigationToken} on:select={(event) => inspectSelection(event.detail.request, event.detail.chronologicalOperation, true)} on:github={reviewManagedGithub} on:switch={() => beginSource('switch')} />
    {:else if activeSection === 'actions'}<ModpackActionPanel {state} {busy} on:verify={verifyModpack} on:repair={() => beginSource('repair')} on:rollback={() => beginManagedOperation('rollback-restore-point')} on:detach={() => beginManagedOperation('detach')} on:uninstall={() => beginManagedOperation('uninstall')} />
    {:else if activeSection === 'history'}
      <section class="mp-panel mp-stack" aria-label="Modpack history">
        <div><p class="mp-kicker">Durable audit history</p><h2 class="mp-title">Lifecycle operations</h2><p class="mp-subtitle">Managed files and user additions remain distinguished in every recorded revision.</p></div>
        {#if historyStatus !== 'ready'}<div class="mp-state" class:error={historyStatus === 'error'} aria-live="polite"><strong>{historyStatus === 'error' ? 'History unavailable' : 'Loading modpack history…'}</strong>{#if historyError}<p>{historyError.message}</p>{/if}{#if history.length}<p>Previously loaded history is not current.</p>{/if}<button class="mp-button" type="button" on:click={() => refresh()} disabled={historyStatus === 'loading' || Boolean(recoveryAction)}>Retry history</button></div>{/if}
        {#if historyStatus === 'ready' && history.length === 0}<div class="mp-state">No modpack history has been recorded for this server.</div>{:else if history.length}<ol class="history-list">{#each history as item (`${item.operationId}-${item.sequence}`)}<li><div><strong>{item.kind?.replaceAll('-', ' ') || 'operation'}</strong><span>{item.outcome || 'recorded'} · {new Date(item.timestamp).toLocaleString()}</span></div><span class="mp-badge">revision {item.sourceRevision ?? '—'} → {item.targetRevision ?? '—'}</span></li>{/each}</ol>{/if}
        {#if historyCursor}<button class="mp-button" type="button" on:click={loadOlderHistory} disabled={busy || historyStatus !== 'ready'}>Load older history</button>{/if}
      </section>
    {:else}<ModpackRecoveryPanel {serverId} records={currentServerRecoveryItems} status={recoveryStatus} loadError={recoveryError} actionError={recoveryActionError} pendingAction={recoveryAction} onRefresh={() => refresh()} onRecover={recoverRecord} />{/if}
  {:else if !lifecycleAvailable && flow !== 'job'}
    <section class="mp-panel mp-state" aria-live="polite"><strong>Lifecycle actions unavailable</strong><p>Current state, history, and recovery must be checked successfully before continuing this review.</p><button class="mp-button" type="button" on:click={() => refresh()} disabled={loading || Boolean(recoveryAction)}>Retry status reads</button></section>
  {:else if flow === 'source'}
    <ModpackSourceChoice {busy} on:select={(event) => event.detail.source === 'local' ? selectLocalArchive() : navigateSelectionFlow(event.detail.source)} on:back={returnToDashboard} />
  {:else if flow === 'modrinth'}
    {#if busy && inspectionProgress}
      <div class="modrinth-inspection-status"><ModpackInspectionProgress progress={inspectionProgress} /></div>
    {/if}
    <ModrinthPackBrowser currentRuntime={state?.runtime || null} {busy} on:select={(event) => inspectSelection(event.detail.request, operationKind)} on:inspectionreset={invalidateInspectionRequests} on:github={reviewLinkedGithub} on:back={() => navigateSelectionFlow('source')} on:local={selectLocalArchive} on:custom={returnToDashboard} />
  {:else if flow === 'github'}
    <GitHubReleasePicker {serverId} {suggestedRepositoryUrl} suggestedModrinthProjectId={linkedModrinthProjectId} currentReleaseId={currentGithubReleaseId} requestedReleaseId={requestedGithubReleaseId} requestedNavigationToken={requestedGithubNavigationToken} allowCurrentReleaseReview={allowCurrentGithubReleaseReview} on:assets={handleGithubAssets} on:back={() => navigateSelectionFlow('source')} on:local={selectLocalArchive} on:custom={returnToDashboard} />
  {:else if flow === 'github-assets'}
    <GitHubAssetReview release={githubRelease} assetResult={githubAssets} {busy} {inspectionProgress} on:select={inspectGithubSelection} on:back={() => navigateSelectionFlow('github')} on:local={selectLocalArchive} on:custom={returnToDashboard} />
  {:else if flow === 'inspection'}
    <ArchiveGuidedReview {inspection} {reviewedPlan} {busy} {error} {operationKind} {preflightProgress} {selectingDestination} on:preflight={buildPreflight} on:filesonly={(event) => buildPreflight(event, 'import-files-only-new')} on:started={handleStarted} on:stale={refreshStaleReview} on:error={(event) => (error = event.detail.error)} on:back={() => abandonInspection('source')} />
  {:else if flow === 'restore-points'}
    <section class="mp-panel mp-stack" aria-label="Choose a restore point"><div><p class="mp-kicker">Exact rollback source</p><h2 class="mp-title">Choose a compatible restore point</h2><p class="mp-subtitle">Rollback reconstructs a fresh candidate from one retained restore point. The archive is fully verified again before a plan can be reviewed. Version downgrade is a separate risk-acknowledged action that first saves the current server for recovery.</p></div>{#if rollbackOptionsLoading}<div class="mp-state" aria-live="polite">Checking retained restore-point archives…</div>{:else if rollbackOptionsError}<div class="mp-state error" role="alert"><strong>Restore points could not be checked</strong><p>{rollbackOptionsError.message}</p><button class="mp-button" type="button" on:click={loadRollbackOptions}>Retry</button></div>{:else if rollbackOptions.length === 0}<div class="mp-state warning"><strong>No retained restore point is available</strong><p>History can outlive a pruned or missing archive. Create or retain a verified restore point before attempting rollback.</p></div>{:else}<ul class="mp-list">{#each rollbackOptions as item (item.restorePointId)}<li><button class="mp-row" class:selected={selectedRestorePointId === item.restorePointId} aria-pressed={selectedRestorePointId === item.restorePointId} type="button" disabled={busy} on:click={() => buildManagementPlan('rollback-restore-point', item.restorePointId)}><span><strong>{item.operationKind?.replaceAll('-', ' ')} restore point</strong><br /><span class="mp-muted">Created {new Date(item.createdAt).toLocaleString()} · source revision {item.sourceRevision} · {item.runtime?.minecraftVersion} {item.runtime?.loaderFamily}</span></span><span class="mp-badge good">{selectedRestorePointId === item.restorePointId && busy ? 'Verifying selection…' : 'Available · verify on selection'}</span></button></li>{/each}</ul>{/if}</section>
  {:else if flow === 'review'}
    <ModpackPlanReview {reviewedPlan} {operationKind} {busy} restorePointId={selectedRestorePointId} on:started={handleStarted} on:stale={refreshStaleReview} on:cancel={() => { reviewedPlan = null; flow = 'source'; }} />
  {:else if flow === 'job'}
    {#key job?.jobId}<ModpackJobProgress bind:job on:return={returnToDashboard} on:terminal={(event) => publishVerificationAttempt(event.detail.job)} on:action={handleOutcomeAction} />{/key}
  {/if}
  {#if busy && inspectionProgress && !['modrinth', 'github-assets', 'inspection', 'review', 'job'].includes(flow)}
    <ModpackInspectionProgress progress={inspectionProgress} />
  {/if}
</div>

<style>
  @import '../components/modpacks/modpack-ui.css';
  .modpack-page { padding: 0.5rem 0 2rem; min-width: 0; }
  .modrinth-inspection-status { position: sticky; top: 4rem; z-index: 2; align-self: start; min-height: 7rem; border-radius: 8px; background: var(--mp-panel); }
  .page-header { padding: 0.4rem 0; }
  .page-actions { display: flex; align-items: center; justify-content: flex-end; gap: 0.55rem; min-height: 42px; }
  .section-tabs { display: flex; gap: 0.45rem; overflow-x: auto; padding: 0.4rem; border: 1px solid var(--mp-border); border-radius: 10px; background: rgba(0, 0, 0, 0.15); }
  .section-tabs button { flex: 1 0 auto; min-width: 110px; border: 1px solid transparent; border-radius: 7px; padding: 0.6rem 0.8rem; background: transparent; color: var(--mp-muted); }
  .section-tabs button.active { color: white; background: rgba(255, 255, 255, 0.09); border-color: rgba(255, 255, 255, 0.28); }
  .history-list { display: grid; gap: 0.55rem; padding: 0; margin: 0; list-style: none; }
  .history-list li { display: flex; justify-content: space-between; align-items: center; gap: 0.7rem; padding: 0.75rem; border: 1px solid var(--mp-border); border-radius: 8px; background: var(--mp-panel-soft); }
  .history-list li div { display: grid; gap: 0.2rem; }
  .history-list li span:not(.mp-badge) { color: var(--mp-muted); font-size: 0.86rem; }
</style>
