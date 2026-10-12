<script>
  import { createEventDispatcher, onDestroy, tick } from 'svelte';
  import Wrench from 'lucide-svelte/icons/wrench';
  import PackageOpen from 'lucide-svelte/icons/package-open';
  import SetupWizard from './SetupWizard.svelte';
  import ModpackSourceChoice from './ModpackSourceChoice.svelte';
  import ModrinthPackBrowser from './ModrinthPackBrowser.svelte';
  import GitHubReleasePicker from './GitHubReleasePicker.svelte';
  import GitHubAssetReview from './GitHubAssetReview.svelte';
  import ArchiveGuidedReview from './ArchiveGuidedReview.svelte';
  import ModpackJobProgress from '../modpacks/ModpackJobProgress.svelte';
  import ModpackInspectionProgress from '../modpacks/ModpackInspectionProgress.svelte';
  import ModpackRecoveryPanel from '../modpacks/ModpackRecoveryPanel.svelte';
  import { ModpackApiError, modpackApi } from '../../utils/modpacks/modpackApi.js';
  import { mergePublicJob } from '../../utils/modpacks/publicJobMerge.js';
  import { isClosedObject as closed, isValidLaunchJob as validLaunchJob, isValidReconciliation as validReconciliation,
    isValidLaunchSummary as validSummary } from '../../utils/modpacks/launchResultValidation.js';
  import {
    createRetryableReservationRelease,
    isNewServerDestinationRecoveryOutcome
  } from '../../utils/modpacks/serverRequestScope.js';

  const dispatch = createEventDispatcher();
  export let instanceId = '';
  export let defaultMaxRam = 4;
  export let defaultServerPort = 25565;

  function normalizedDefaultMaxRam(value) {
    const parsed = Number(value);
    return Number.isSafeInteger(parsed) && parsed >= 1 && parsed <= 64 ? parsed : 4;
  }

  function normalizedServerPort(value) {
    const parsed = Number(value);
    return Number.isSafeInteger(parsed) && parsed >= 1025 && parsed <= 65535 ? parsed : 25565;
  }

  let stage = 'method';
  let source = '';
  let inspection = null;
  let reviewedPlan = null;
  let sourceLabel = '';
  let selectedRequest = null;
  let githubAssets = null;
  let githubRelease = null;
  let suggestedRepositoryUrl = '';
  let linkedModrinthProjectId = '';
  let approvedLinkedModrinthProjectId = null;
  let busy = false;
  let error = null;
  let job = null;
  let pendingInstanceId = instanceId;
  let reservedDestinationName = '';
  let heading;
  let inspectionRequestSequence = 0;
  let activeInspectionRequestSequence = null;
  let inspectionProgress = null;
  let preflightProgress = null;
  let selectingDestination = false;
  let destinationNotice = '';
  let activeInspectionController = null;
  let ownsPendingDestination = false;
  let alive = true;
  let ownerEpoch = 0;
  let reservationRecord = null;
  let planningOwner = null;
  let reviewContext = null;
  let selectedLaunch = null;
  let selectionContext = null;
  let launchNotice = '';
  let launchSettlement = null;
  let launchCandidates = [];
  let launchCursor = null;
  let discoveryOwner = null;
  let discoveryBusy = false;
  let discoveryError = '';
  let discoveryNotice = '';
  const launchAttempts = [];
  const terminalPhases = new Set(['completed', 'cancelled', 'rolled-back', 'failed', 'recovery-required']);
  const identifier = value => typeof value === 'string' && /^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/u.test(value);
  const fingerprint = value => typeof value === 'string' && /^[a-f0-9]{64}$/u.test(value);

  function currentIntent(epoch) { return alive && ownerEpoch === epoch; }
  function currentAttempt(attempt) { return currentIntent(attempt.ownerEpoch) && selectedLaunch === attempt; }
  function protectedLaunch() { return launchAttempts.some(attempt => ['launch-pending', 'unknown'].includes(attempt.status)); }
  function invalidateIntent() {
    ownerEpoch += 1;
    planningOwner = null;
    reviewContext = null;
    selectionContext = null;
    selectedLaunch = null;
    for (const attempt of launchAttempts) { clearTimeout(attempt.timer); clearTimeout(attempt.completionTimer); attempt.timer = null; attempt.completionTimer = null; }
    discoveryOwner = null;
    discoveryBusy = false;
    busy = false;
    selectingDestination = false;
    preflightProgress = null;
  }

  function settlementCopy(value) {
    if (!value || ['active', 'settled'].includes(value.status)) return '';
    return value.status === 'repair-pending' ? 'Settlement repair is pending. The destination remains held; checking status does not repair it.' :
      value.status === 'recovery-required' ? 'Recovery is required. Review the existing recovery options; this status check does not run recovery.' :
      'Support is required to establish a safe settlement. No destination release or recovery action is authorized by this status.';
  }

  const stepOrder = ['method', 'source', 'select', 'review', 'progress'];
  $: activeStep = stage === 'custom' ? 'method' : ['modrinth', 'github', 'github-assets', 'local'].includes(stage) ? 'select' : stage;
  $: activeStepIndex = stepOrder.indexOf(activeStep);
  $: if (stage) focusHeading(stage);

  async function focusHeading() {
    await tick();
    heading?.focus?.();
  }

  function beginInspectionRequest(showInitialProgress = true) {
    activeInspectionController?.abort();
    const controller = new AbortController();
    const requestSequence = ++inspectionRequestSequence;
    activeInspectionRequestSequence = requestSequence;
    activeInspectionController = controller;
    busy = true;
    error = null;
    inspectionProgress = showInitialProgress ? { phase: 'resolving' } : null;
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

  async function releasePendingDestination(record = reservationRecord) {
    if (!record || record.state !== 'unlaunched') return false;
    record.releasePending = true;
    let released;
    try { released = await record.release(record.instanceId); }
    finally { record.releasePending = false; }
    if (released !== true) return false;
    record.state = 'released';
    if (alive && reservationRecord === record) {
      reservationRecord = null;
      ownsPendingDestination = false;
      pendingInstanceId = instanceId;
      reservedDestinationName = '';
    }
    return released;
  }

  function navigateStage(nextStage) {
    invalidateIntent();
    invalidateInspectionRequests();
    stage = nextStage;
  }

  function chooseMethod(method) {
    invalidateIntent();
    invalidateInspectionRequests();
    error = null;
    stage = method === 'custom' ? 'custom' : 'source';
  }

  function chooseSource(event) {
    if (busy || protectedLaunch()) return;
    invalidateIntent();
    invalidateInspectionRequests();
    source = event.detail.source;
    if (source === 'local') return selectLocalArchive();
    if (source === 'github') {
      suggestedRepositoryUrl = '';
      linkedModrinthProjectId = '';
      approvedLinkedModrinthProjectId = null;
    }
    stage = source;
  }

  function reviewLinkedGithub(event) {
    invalidateInspectionRequests();
    suggestedRepositoryUrl = event.detail.repositoryUrl;
    linkedModrinthProjectId = event.detail.modrinthProjectId;
    approvedLinkedModrinthProjectId = null;
    stage = 'github';
  }

  async function selectLocalArchive() {
    if (busy) return;
    const inspectionRequest = beginInspectionRequest(false);
    const { requestSequence } = inspectionRequest;
    try {
      const selection = await modpackApi.selectLocalArchive(true);
      if (requestSequence !== inspectionRequestSequence) return;
      if (!selection?.selectionId) return;
      const request = { provider: 'local', selectionId: selection.selectionId };
      const label = selection.displayName || 'Local archive';
      await inspectSelection(request, label, true);
    } catch (caught) {
      if (requestSequence !== inspectionRequestSequence) return;
      error = caught;
      stage = 'source';
    } finally {
      finishInspectionRequest(inspectionRequest);
    }
  }

  async function inspectSelection(request, label, allowBusy = false) {
    if ((busy && !allowBusy) || protectedLaunch()) return;
    invalidateIntent();
    const inspectionRequest = beginInspectionRequest();
    const { requestSequence } = inspectionRequest;
    const requestedSelection = {
      ...request,
      ...(Array.isArray(request?.assetIds) ? { assetIds: [...request.assetIds] } : {})
    };
    const requestedLabel = label;
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
      sourceLabel = requestedLabel;
      inspection = nextInspection;
      reviewedPlan = null;
      destinationNotice = '';
      stage = 'review';
    } catch (caught) {
      if (requestSequence !== inspectionRequestSequence) return;
      error = caught;
    } finally {
      finishInspectionRequest(inspectionRequest);
    }
  }

  function handleGithubAssets(event) {
    invalidateInspectionRequests();
    githubRelease = event.detail.release;
    githubAssets = event.detail.assets;
    approvedLinkedModrinthProjectId = event.detail.linkedModrinthProjectId || null;
    stage = 'github-assets';
  }

  function inspectGithubSelection(event) {
    return inspectSelection({
      ...event.detail.request,
      rememberAssetPattern: Boolean(event.detail.rememberPattern),
      ...(approvedLinkedModrinthProjectId ? { linkedModrinthProjectId: approvedLinkedModrinthProjectId } : {})
    }, event.detail.label);
  }

  async function ensureTargetInstance(owner) {
    if (reservationRecord?.state === 'unlaunched' && !reservationRecord.releasePending) return reservationRecord;
    if (pendingInstanceId && !reservationRecord) {
      reservationRecord = { instanceId: pendingInstanceId, displayName: '', state: 'unlaunched', release: async () => false };
      return reservationRecord;
    }
    const reservation = await modpackApi.reserveServerDestination();
    if (!reservation) return null;
    if (!identifier(reservation.instanceId)) throw new Error('The selected destination could not be confirmed.');
    const record = { instanceId: reservation.instanceId, displayName: reservation.displayName || 'Selected server destination', state: 'unlaunched',
      release: createRetryableReservationRelease(id => modpackApi.releaseServerDestination(id)) };
    if (!currentIntent(owner.epoch) || planningOwner !== owner) {
      await releasePendingDestination(record);
      return null;
    }
    reservationRecord = record;
    pendingInstanceId = reservation.instanceId;
    ownsPendingDestination = true;
    reservedDestinationName = reservation.displayName || 'Selected server destination';
    return record;
  }

  async function buildPreflight(event, requestedKind = null) {
    if (!alive || busy || protectedLaunch() || !inspection?.inspectionId) return;
    invalidateIntent();
    const owner = { epoch: ownerEpoch, inspectionId: inspection.inspectionId, sourceLabel, operationKind: requestedKind || 'install-new',
      selections: JSON.parse(JSON.stringify(event?.detail?.selections || {
        optionalFileIds: [], conflictChoices: {}, acknowledgeMissingProviderDigest: false, acknowledgeDowngradeWorldRisk: false,
        selectedRoot: null, runtimeChoice: null,
        maxRam: requestedKind === 'import-files-only-new' ? null : normalizedDefaultMaxRam(defaultMaxRam),
        serverPort: requestedKind === 'import-files-only-new' ? null : normalizedServerPort(defaultServerPort),
        networkAccess: requestedKind === 'import-files-only-new' ? null : 'pack-default'
      })) };
    planningOwner = owner;
    const isCurrent = () => currentIntent(owner.epoch) && planningOwner === owner;
    busy = true;
    error = null;
    preflightProgress = null;
    destinationNotice = '';
    selectingDestination = !pendingInstanceId;
    try {
      const record = await ensureTargetInstance(owner);
      if (!isCurrent()) return;
      if (!record) {
        destinationNotice = 'No destination was selected. Choose a folder to continue.';
        return;
      }
      selectingDestination = false;
      destinationNotice = '';
      preflightProgress = { phase: 'validating-destination', percent: 0 };
      const nextPlan = await modpackApi.preflight({ inspectionId: owner.inspectionId, instanceId: record.instanceId,
        operationKind: owner.operationKind, selections: owner.selections }, progress => { if (isCurrent()) preflightProgress = progress; });
      if (!isCurrent() || reservationRecord !== record || record.state !== 'unlaunched') return;
      reviewedPlan = nextPlan;
      reviewContext = Object.freeze({ ownerEpoch: owner.epoch, plan: nextPlan, serverId: record.instanceId, operationKind: owner.operationKind, sourceLabel: owner.sourceLabel, reservationRecord: record });
    } catch (caught) {
      if (isCurrent()) error = caught;
    } finally {
      if (isCurrent()) { selectingDestination = false; preflightProgress = null; busy = false; }
    }
  }

  async function refreshStaleReview() {
    invalidateIntent();
    const epoch = ownerEpoch;
    const record = reservationRecord;
    const requestedSelection = selectedRequest ? {
      ...selectedRequest,
      ...(Array.isArray(selectedRequest.assetIds) ? { assetIds: [...selectedRequest.assetIds] } : {})
    } : null;
    const requestedLabel = sourceLabel;
    const staleInspection = inspection;
    reviewedPlan = null;
    inspection = null;
    error = null;
    busy = true;
    try {
      await Promise.all([
        discardInspectionSession(staleInspection),
        releasePendingDestination(record)
      ]);
    } catch (caught) {
      if (currentIntent(epoch)) { error = caught; busy = false; }
      return;
    }
    if (!currentIntent(epoch)) return;
    busy = false;
    stage = 'source';

    if (!requestedSelection || requestedSelection?.provider === 'local') {
      selectedRequest = null;
      error = new ModpackApiError({
        code: 'PLAN_STALE',
        message: 'The reviewed plan expired. Select the local archive again, choose the server destination again, and run a fresh preflight review. Nothing was installed.'
      });
      return;
    }

    await inspectSelection(requestedSelection, requestedLabel);
  }

  async function adoptLaunch(attempt, value) {
    if (!validLaunchJob(value, attempt)) throw new Error('The exact launched operation could not be confirmed.');
    attempt.jobId = value.jobId;
    attempt.serverId = value.serverId;
    attempt.operationKind = value.operationKind;
    attempt.status = 'job-owned';
    if (attempt.reservationRecord) attempt.reservationRecord.state = 'job-owned';
    for (const prior of launchAttempts) {
      if (prior.planId === attempt.planId && prior.planFingerprint === attempt.planFingerprint &&
          (!prior.jobId || prior.jobId === value.jobId) && (!prior.serverId || prior.serverId === value.serverId) && (!prior.operationKind || prior.operationKind === value.operationKind)) {
        prior.jobId = value.jobId;
        prior.serverId = value.serverId;
        prior.operationKind = value.operationKind;
        prior.status = 'job-owned';
        if (prior.reservationRecord) prior.reservationRecord.state = 'job-owned';
      }
    }
    // Resource ownership settles even after the originating view has gone away.
    if (!currentAttempt(attempt)) return;
    const hydrated = await modpackApi.getJob(attempt.jobId);
    if (!validLaunchJob(hydrated, attempt) || hydrated.sequence < value.sequence) throw new Error('The launched operation is awaiting an authoritative status.');
    if (!currentAttempt(attempt)) return;
    job = mergePublicJob(value, hydrated, { durable: true });
    if (!attempt.reservationRecord) attempt.reservationRecord = { instanceId: attempt.serverId, state: 'job-owned',
      release: createRetryableReservationRelease(id => modpackApi.releaseServerDestination(id)) };
    reservationRecord = attempt.reservationRecord;
    ownsPendingDestination = false;
    pendingInstanceId = attempt.serverId;
    launchNotice = '';
    selectionContext = Object.freeze({ ownerEpoch, attempt, serverId: attempt.serverId, jobId: attempt.jobId });
    stage = 'progress';
  }

  function scheduleReconciliation(attempt) {
    if (!currentAttempt(attempt) || attempt.timer || attempt.reading) return;
    attempt.timer = setTimeout(() => { attempt.timer = null; void reconcileLaunch(attempt); }, 1200);
  }

  async function reconcileLaunch(attempt) {
    if (attempt.reading) return attempt.reading;
    const work = async () => {
      try {
        const result = await modpackApi.reconcileNewServerLaunch({ planId: attempt.planId, planFingerprint: attempt.planFingerprint });
        if (!validReconciliation(result, attempt)) throw new Error('Launch status could not be confirmed safely.');
        if (result.status === 'started') {
          attempt.settlement = result.settlement;
          if (currentAttempt(attempt)) launchSettlement = result.settlement;
          await adoptLaunch(attempt, result.job);
          return;
        }
        if (result.status === 'not-started') {
          for (const prior of launchAttempts) if (prior.planId === attempt.planId && prior.planFingerprint === attempt.planFingerprint) prior.status = 'not-started';
          if (currentAttempt(attempt)) launchNotice = 'This exact launch did not start. You may go back and run a fresh review. No server files will be deleted.';
          return;
        }
        attempt.status = 'unknown';
        if (attempt.reservationRecord && attempt.reservationRecord.state !== 'job-owned') attempt.reservationRecord.state = 'unknown';
        if (currentAttempt(attempt)) {
          launchNotice = result.status === 'pending' ? result.reason === 'admission-unresolved'
            ? 'Start outcome is unknown; it may already have started. Admission is still unresolved. The destination remains protected.'
            : 'Start outcome is unknown; it may already have started. Checking the exact launch; the destination remains protected.'
            : result.status === 'not-observed' ? 'Start outcome is unknown. No job is observed, but this plan is still usable; absence is not permission to reuse the destination.'
            : result.status === 'unavailable' ? 'Exact launch correlation is unavailable for this older plan. Use the existing recovery or support workflow; no absence or release is confirmed.'
            : 'Launch correlation requires recovery or support. The destination remains protected; no job has been guessed.';
        }
        attempt.retry = result.status === 'pending';
      } catch {
        if (currentAttempt(attempt)) launchNotice = 'Start outcome is unknown; it may already have started. Status is unavailable. Checking again will not start or release anything.';
        attempt.retry = true;
      }
    };
    attempt.retry = false;
    attempt.reading = Promise.resolve().then(work).finally(() => {
      attempt.reading = null;
      if (attempt.retry) scheduleReconciliation(attempt);
    });
    return attempt.reading;
  }

  function startReviewedOperation(request) {
    const context = request?.reviewContext;
    const prior = launchAttempts.find(attempt => attempt.reviewContext === context);
    if (prior) return prior.promise;
    const record = context?.reservationRecord;
    if (!alive || stage !== 'review' || context !== reviewContext || context?.plan !== reviewedPlan ||
        !currentIntent(context?.ownerEpoch) || !record || record !== reservationRecord || record.state !== 'unlaunched' || record.releasePending || protectedLaunch() ||
        request.planId !== reviewedPlan?.planId || request.planFingerprint !== reviewedPlan?.planFingerprint ||
        !identifier(request.planId) || !fingerprint(request.planFingerprint) || !identifier(context.serverId) ||
        !['install-new', 'import-files-only-new'].includes(context.operationKind)) {
      return Promise.resolve({ status: 'not-invoked', error: new ModpackApiError({ code: 'PLAN_STALE', message: 'The review changed before Start was invoked. Run a fresh preflight review.' }) });
    }
    const choices = { acceptEula: request.choices?.acceptEula === true, startAfterInstall: request.choices?.startAfterInstall === true, restorePointId: null };
    if (!choices.acceptEula) return Promise.resolve({ status: 'not-invoked' });
    const attempt = { ownerEpoch, reviewContext: context, planId: request.planId, planFingerprint: request.planFingerprint,
      operationKind: context.operationKind, serverId: context.serverId, sourceLabel: context.sourceLabel, reservationRecord: record,
      status: 'launch-pending', jobId: null, promise: null, reading: null, timer: null, completed: false };
    record.state = 'launch-pending';
    launchAttempts.push(attempt);
    selectedLaunch = attempt;
    let resolveAttempt;
    attempt.promise = new Promise(resolve => { resolveAttempt = resolve; });
    // All ownership and dedup state is installed before synchronous bridge entry.
    void (async () => {
      try {
        const value = await modpackApi.startOperation({ planId: attempt.planId, planFingerprint: attempt.planFingerprint, choices });
        await adoptLaunch(attempt, value);
        resolveAttempt({ status: 'started' });
      } catch {
        if (attempt.status !== 'job-owned') { attempt.status = 'unknown'; record.state = 'unknown'; }
        if (currentAttempt(attempt)) launchNotice = 'Start outcome is unknown; it may already have started. Checking the exact launch; the destination remains protected.';
        await reconcileLaunch(attempt);
        resolveAttempt({ status: attempt.status === 'job-owned' && stage === 'progress' ? 'started' : 'unknown' });
      }
    })();
    return attempt.promise;
  }

  function completeSetup(event) {
    const context = event.detail?.selectionContext;
    const attempt = context?.attempt;
    const incoming = event.detail?.job;
    // Progress may contain transport-only channel/terminal fields and old
    // snapshot-only timestamps. It is a hint, never confirming durable data.
    const data = key => Object.getOwnPropertyDescriptor(incoming || {}, key)?.value;
    if (context !== selectionContext || !attempt || !currentAttempt(attempt) || attempt.completed ||
        context.jobId !== job?.jobId || data('jobId') !== attempt.jobId || data('serverId') !== attempt.serverId ||
        data('operationKind') !== attempt.operationKind || data('planFingerprint') !== attempt.planFingerprint ||
        !terminalPhases.has(data('phase')) || !Number.isSafeInteger(data('sequence')) || data('sequence') < job.sequence) return;
    attempt.confirmThrough = Math.max(attempt.confirmThrough ?? -1, incoming.sequence);
    if (attempt.confirming) return attempt.confirming;
    clearTimeout(attempt.completionTimer);
    attempt.completionTimer = null;
    attempt.confirming = (async () => {
      let retry = false;
      try {
        const confirmed = await modpackApi.getJob(attempt.jobId);
        if (!currentAttempt(attempt) || selectionContext !== context || job?.jobId !== context.jobId) return;
        if (!validLaunchJob(confirmed, attempt) || confirmed.sequence < attempt.confirmThrough || confirmed.sequence < job.sequence) { retry = true; return; }
        job = mergePublicJob(job, confirmed, { durable: true });
        if (confirmed.phase !== 'completed' || attempt.completed) return;
        // Explicit recovery can create another view owner for the same launch.
        // Completion belongs to that exact launch, not only its current view.
        for (const owned of launchAttempts) {
          if (owned.planId === attempt.planId && owned.planFingerprint === attempt.planFingerprint &&
              owned.jobId === attempt.jobId && owned.serverId === attempt.serverId && owned.operationKind === attempt.operationKind) owned.completed = true;
        }
        dispatch('setup-complete', { instanceId: attempt.serverId, modpackJobId: attempt.jobId, source: attempt.sourceLabel });
      } catch {
        retry = true;
        if (currentAttempt(attempt) && selectionContext === context) launchNotice = 'Completion is awaiting an authoritative status. No destination release is confirmed.';
      } finally {
        attempt.confirming = null;
        if (retry && currentAttempt(attempt) && selectionContext === context && !attempt.completed) {
          attempt.completionTimer = setTimeout(() => { attempt.completionTimer = null; void completeSetup(event); }, 1200);
        }
      }
    })();
    return attempt.confirming;
  }

  async function refreshLaunches(more = false, notice = '') {
    const owner = { epoch: ownerEpoch, cursor: more ? launchCursor : null };
    discoveryOwner = owner;
    discoveryBusy = true;
    discoveryError = '';
    discoveryNotice = notice;
    const isCurrent = () => currentIntent(owner.epoch) && discoveryOwner === owner;
    try {
      const result = await modpackApi.listNewServerLaunches({ limit: 50, ...(owner.cursor ? { cursor: owner.cursor } : {}) });
      if (!closed(result, ['items', 'nextCursor']) || !Array.isArray(result.items) || result.items.length > 50 || !result.items.every(validSummary) ||
          result.nextCursor !== null && (typeof result.nextCursor !== 'string' || !/^launch-cursor-v1-[a-f0-9]{8}-[a-f0-9]{4}-4[a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}$/u.test(result.nextCursor))) throw new Error('Invalid launch list');
      if (!isCurrent()) return;
      const combined = [...(more ? launchCandidates : []), ...result.items];
      if (combined.length > 2000) throw new Error('Launch list limit');
      launchCandidates = [...new Map(combined.map(item => [item.planId, item])).values()];
      launchCursor = result.nextCursor;
    } catch (caught) {
      if (!isCurrent()) return;
      if (caught.code === 'LAUNCH_CURSOR_EXPIRED' && owner.cursor) {
        launchCandidates = []; launchCursor = null;
        await refreshLaunches(false, 'The previous list expired. Showing a fresh snapshot; choose the exact setup again.');
      } else discoveryError = caught.code === 'LAUNCH_LIST_LIMIT_EXCEEDED' ? 'There are too many launches to list safely. The list is not complete. Exact known launch status remains available; contact support.' :
        caught.code === 'LAUNCH_DISCOVERY_CAPACITY' ? 'Previous setup discovery is at capacity. Try Refresh again later; exact launch status and destination protection are unchanged.' : 'Previous setups could not be listed safely. Refresh to try again; no destination release is confirmed.';
    } finally { if (isCurrent()) discoveryBusy = false; }
  }

  async function selectLaunch(candidate) {
    if (!alive || !launchCandidates.includes(candidate) || !validSummary(candidate)) return;
    const prior = launchAttempts.find(attempt => attempt.planId === candidate.planId && attempt.planFingerprint === candidate.planFingerprint);
    if (prior && (candidate.serverId && prior.serverId && candidate.serverId !== prior.serverId ||
        candidate.operationKind && prior.operationKind && candidate.operationKind !== prior.operationKind || candidate.jobId && prior.jobId && candidate.jobId !== prior.jobId)) {
      discoveryError = 'This setup summary conflicts with the captured launch. Check the exact original launch or contact support.';
      return;
    }
    invalidateIntent();
    const attempt = { ownerEpoch, planId: candidate.planId, planFingerprint: candidate.planFingerprint,
      serverId: candidate.serverId || prior?.serverId || null, operationKind: candidate.operationKind || prior?.operationKind || null, jobId: candidate.jobId || prior?.jobId || null,
      sourceLabel: prior?.sourceLabel || candidate.displayName || 'Previous setup', reservationRecord: prior?.reservationRecord || null, status: 'unknown', timer: null, reading: null, completed: prior?.completed || false };
    launchAttempts.push(attempt);
    selectedLaunch = attempt;
    launchNotice = 'Start outcome is unknown; checking the explicitly selected launch.';
    await reconcileLaunch(attempt);
  }

  async function goToSource() {
    const record = reservationRecord;
    invalidateIntent();
    const epoch = ownerEpoch;
    invalidateInspectionRequests();
    const abandonedInspection = inspection;
    error = null;
    reviewedPlan = null;
    inspection = null;
    githubAssets = null;
    githubRelease = null;
    suggestedRepositoryUrl = '';
    linkedModrinthProjectId = '';
    approvedLinkedModrinthProjectId = null;
    destinationNotice = '';
    stage = 'source';
    job = null;
    busy = false;
    try {
      await Promise.all([
        discardInspectionSession(abandonedInspection),
        releasePendingDestination(record)
      ]);
    } catch (caught) {
      if (currentIntent(epoch)) error = caught;
    } finally {
      if (currentIntent(epoch)) busy = false;
    }
  }

  async function handleOutcomeAction(event) {
    const value = event.detail?.value;
    if (value?.type !== 'outcome-action-result') return;
    const destination = value.destination;
    if (!destination || !['selection', 'asset-selection'].includes(destination.kind)) return;
    const context = event.detail?.selectionContext;
    const attempt = context?.attempt;
    const actionJob = event.detail?.job;
    if (!context || context !== selectionContext || !attempt || !currentAttempt(attempt) || !validLaunchJob(actionJob, attempt) ||
        actionJob.sequence !== job?.sequence || !actionJob.outcome?.actions?.some(action => action.actionId === event.detail.actionId)) return;
    const resetDestination = isNewServerDestinationRecoveryOutcome(event.detail?.job?.outcome);
    if (resetDestination) {
      const record = attempt.reservationRecord;
      const hydrated = await modpackApi.getJob(attempt.jobId).catch(() => null);
      if (!validLaunchJob(hydrated, attempt) || hydrated.sequence !== actionJob.sequence || !isNewServerDestinationRecoveryOutcome(hydrated.outcome) ||
          !currentAttempt(attempt) || context !== selectionContext || job?.sequence !== actionJob.sequence ||
          !hydrated.outcome?.actions?.some(action => action.actionId === event.detail.actionId) || !record || reservationRecord !== record) return;
      const released = await record.release(record.instanceId).catch(() => false);
      if (released !== true) return;
      record.state = 'released';
      if (!currentAttempt(attempt) || context !== selectionContext || reservationRecord !== record || job?.sequence !== actionJob.sequence) return;
      reservationRecord = null;
      ownsPendingDestination = false;
      pendingInstanceId = instanceId;
      reservedDestinationName = '';
    }
    job = null;
    await goToSource();
  }

  onDestroy(() => {
    alive = false;
    invalidateIntent();
    invalidateInspectionRequests();
    const abandonedInspection = inspection;
    inspection = null;
    void discardInspectionSession(abandonedInspection).catch(() => {});
    void releasePendingDestination(reservationRecord).catch(() => {});
  });
</script>

<div class="modpack-surface setup-shell">
  {#if stage !== 'custom'}
    <nav class="stepper" aria-label="Server setup progress">
      {#each stepOrder as stepName, index (stepName)}
        <span class:completed={index < activeStepIndex} class:current={index === activeStepIndex} class:upcoming={index > activeStepIndex} aria-current={activeStep === stepName ? 'step' : undefined}><b>{index < activeStepIndex ? '✓' : index + 1}</b>{stepName === 'method' ? 'Method' : stepName === 'source' ? 'Source' : stepName === 'select' ? 'Version or asset' : stepName === 'review' ? 'Review' : 'Install'}<span class="mp-sr-only">{index < activeStepIndex ? ' completed' : index === activeStepIndex ? ' current step' : ' upcoming'}</span></span>
      {/each}
    </nav>
  {/if}

  {#if launchNotice}<section class="mp-state warning" role="status" aria-live="polite"><p>{launchNotice}</p>{#if selectedLaunch && !selectedLaunch.reading}<button class="mp-button" type="button" on:click={() => reconcileLaunch(selectedLaunch)}>Check exact launch status</button>{/if}</section>{/if}
  {#if launchSettlement && settlementCopy(launchSettlement)}<section class="mp-state warning" role="status"><p>{settlementCopy(launchSettlement)}</p></section>{/if}

  {#if error && stage !== 'review'}
    <section class="mp-state error global-error" bind:this={heading} tabindex="-1" aria-live="assertive"><strong>{error.code || 'Modpack setup error'}</strong><p>{error.message}</p><button class="mp-button" type="button" on:click={() => { error = null; }}>Dismiss</button></section>
  {:else}
    <span class="mp-sr-only" bind:this={heading} tabindex="-1">Current setup step: {activeStep}</span>
  {/if}

  {#if stage === 'method'}
    <ModpackRecoveryPanel visibilityScope="pending-new-server" context="setup" hideWhenEmpty />
    <section class="method-panel mp-stack">
      <div><p class="mp-kicker">Create a server</p><h1 class="mp-title">How do you want to set it up?</h1><p class="mp-subtitle">The existing manual setup remains unchanged. Modpacks use exact reviewed sources and transactional installation.</p></div>
      <div class="mp-grid">
        <button type="button" class="mp-card method-card" on:click={() => chooseMethod('custom')}><Wrench class="method-icon" aria-hidden="true" /><strong>Empty/Custom Server</strong><span>Choose Minecraft, loader, Java, and add individual mods yourself.</span><small>Available</small></button>
        <button type="button" class="mp-card method-card" on:click={() => chooseMethod('modpack')}><PackageOpen class="method-icon" aria-hidden="true" /><strong>Install Modpack</strong><span>Browse Modrinth, inspect GitHub Release ZIP/RAR assets, or import a local archive.</span><small>Available</small></button>
      </div>
    </section>
  {:else if stage === 'custom'}
    <div class="custom-flow"><button type="button" class="mp-button back-button" on:click={() => navigateStage('method')}>Back to setup method</button><SetupWizard on:setup-complete={(event) => dispatch('setup-complete', event.detail)} /></div>
  {:else if stage === 'source'}
    <ModpackSourceChoice {busy} on:select={chooseSource} on:back={() => navigateStage('method')} />
    {#if busy}<div class="mp-state">Opening the native archive picker…</div>{/if}
  {:else if stage === 'modrinth'}
    {#if busy && inspectionProgress}
      <div class="modrinth-inspection-status"><ModpackInspectionProgress progress={inspectionProgress} /></div>
    {/if}
    <ModrinthPackBrowser {busy} on:select={(event) => inspectSelection(event.detail.request, event.detail.label)} on:inspectionreset={invalidateInspectionRequests} on:github={reviewLinkedGithub} on:back={goToSource} on:local={selectLocalArchive} on:custom={() => navigateStage('custom')} />
  {:else if stage === 'github'}
    <GitHubReleasePicker {suggestedRepositoryUrl} suggestedModrinthProjectId={linkedModrinthProjectId} on:assets={handleGithubAssets} on:back={goToSource} on:local={selectLocalArchive} on:custom={() => navigateStage('custom')} />
  {:else if stage === 'github-assets'}
    <GitHubAssetReview release={githubRelease} assetResult={githubAssets} {busy} {inspectionProgress} on:select={inspectGithubSelection} on:back={() => navigateStage('github')} on:local={selectLocalArchive} on:custom={() => navigateStage('custom')} />
  {:else if stage === 'review'}
    <p class="mp-muted destination-note">When you start preflight, Minecraft Core opens the native folder picker, then runs preflight checks before changing any server files.</p>
    {#if destinationNotice}<div class="mp-state destination-notice" role="status" aria-live="polite">{destinationNotice}</div>{/if}
    <ArchiveGuidedReview {inspection} {reviewedPlan} {reviewContext} {startReviewedOperation} busy={busy || protectedLaunch()} {error} {preflightProgress} {selectingDestination} {defaultMaxRam} {defaultServerPort} operationKind="install-new" on:preflight={buildPreflight} on:filesonly={(event) => buildPreflight(event, 'import-files-only-new')} on:stale={refreshStaleReview} on:error={(event) => (error = event.detail.error)} on:back={goToSource} />
    {#if reservedDestinationName}<p class="mp-muted destination-note"><strong>Chosen destination:</strong> {reservedDestinationName}. This safe display name is all this review exposes.</p>{/if}
  {:else if stage === 'progress'}
    {#key selectionContext}<ModpackJobProgress {job} {selectionContext} on:terminal={completeSetup} on:action={handleOutcomeAction} on:return={() => { job = null; navigateStage('source'); }} />{/key}
  {/if}

  {#if ['method', 'source'].includes(stage)}
    <details class="previous-setups mp-panel">
      <summary>Previous server setups</summary>
      <section class="mp-stack" aria-label="Previous server setups">
        <p class="mp-muted">Refresh, then explicitly choose the exact setup to inspect. Nothing is selected automatically.</p>
        <button class="mp-button" type="button" on:click={() => refreshLaunches(false)}>Refresh previous setups</button>
        {#if discoveryBusy}<p role="status">Reading previous setup identities…</p>{/if}
        {#if discoveryError}<p role="alert">{discoveryError}</p>{/if}
        {#if discoveryNotice}<p role="status">{discoveryNotice}</p>{/if}
        {#each launchCandidates as candidate (candidate.planId)}<button class="mp-button" type="button" on:click={() => selectLaunch(candidate)}>{candidate.displayName || 'Unresolved setup'} · {candidate.status} · {candidate.planId}</button>{/each}
        {#if launchCursor}<button class="mp-button" type="button" disabled={discoveryBusy} on:click={() => refreshLaunches(true)}>Load more previous setups</button>{/if}
      </section>
    </details>
  {/if}

  {#if busy && inspectionProgress && !['modrinth', 'github-assets', 'review', 'progress'].includes(stage)}
    <ModpackInspectionProgress progress={inspectionProgress} />
  {/if}
</div>

<style>
  @import '../modpacks/modpack-ui.css';
  .setup-shell { display: grid; gap: 1rem; }
  .previous-setups { padding: 0.75rem 1rem; }
  .previous-setups summary { cursor: pointer; font-weight: 600; }
  .previous-setups summary:focus-visible { outline: 2px solid rgba(196, 199, 255, 0.72); outline-offset: 4px; }
  .previous-setups section { margin-top: 0.75rem; }
  .modrinth-inspection-status { position: sticky; top: 4rem; z-index: 2; align-self: start; min-height: 7rem; border-radius: 8px; background: var(--mp-panel); }
  .stepper { display: grid; grid-template-columns: repeat(5, minmax(0, 1fr)); gap: 0.35rem; padding: 0.55rem; border: 1px solid var(--mp-border); border-radius: 10px; background: rgba(0, 0, 0, 0.16); }
  .stepper span { display: flex; align-items: center; justify-content: center; gap: 0.4rem; min-height: 38px; padding: 0.25rem; color: var(--mp-muted); font-size: 0.8rem; text-align: center; border-radius: 7px; }
  .stepper span b { display: inline-grid; place-items: center; width: 1.35rem; height: 1.35rem; border-radius: 999px; border: 1px solid var(--mp-border); }
  .stepper span.current { background: rgba(255, 255, 255, 0.09); color: white; }
  .stepper span.current b { background: rgba(255, 255, 255, 0.16); border-color: rgba(255, 255, 255, 0.42); }
  .stepper span.completed { color: rgba(255, 255, 255, 0.82); }
  .stepper span.completed b { color: var(--mp-good); border-color: rgba(98, 216, 154, 0.42); }
  .stepper span.upcoming { opacity: 0.72; }
  .method-panel { padding: clamp(0.5rem, 3vw, 2rem); }
  .method-card { display: grid; align-content: start; min-height: 220px; gap: 0.8rem; color: inherit; text-align: left; font: inherit; cursor: pointer; }
  .method-card:hover:not(:disabled) { border-color: rgba(255, 255, 255, 0.3); transform: translateY(-2px); }
  .method-card:focus-visible { border-color: rgba(196, 199, 255, 0.78); outline: 2px solid rgba(196, 199, 255, 0.72); outline-offset: 2px; }
  .method-card .method-icon { width: 2rem; height: 2rem; color: #aeb3ff; }
  .method-card strong { font-size: 1.2rem; }
  .method-card > span:not(.icon) { color: var(--mp-muted); }
  .method-card small { color: var(--mp-good); }
  .custom-flow { position: relative; }
  .back-button { margin-bottom: 0.8rem; }
  .global-error { margin-bottom: 0.2rem; }
  .destination-note { margin: 0; }
  @media (max-width: 700px) { .stepper { grid-template-columns: 1fr; } .stepper span { justify-content: flex-start; } }
</style>
