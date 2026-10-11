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
  const releaseDestination = createRetryableReservationRelease(instanceId => modpackApi.releaseServerDestination(instanceId));

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

  async function releasePendingDestination() {
    if (!ownsPendingDestination || !pendingInstanceId) return false;
    const abandonedInstanceId = pendingInstanceId;
    const released = await releaseDestination(abandonedInstanceId);
    if (ownsPendingDestination && pendingInstanceId === abandonedInstanceId) {
      ownsPendingDestination = false;
      pendingInstanceId = instanceId;
      reservedDestinationName = '';
    }
    return released;
  }

  function navigateStage(nextStage) {
    invalidateInspectionRequests();
    stage = nextStage;
  }

  function chooseMethod(method) {
    invalidateInspectionRequests();
    error = null;
    stage = method === 'custom' ? 'custom' : 'source';
  }

  function chooseSource(event) {
    if (busy) return;
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
    if (busy && !allowBusy) return;
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

  async function ensureTargetInstance() {
    if (pendingInstanceId) return pendingInstanceId;
    const reservation = await modpackApi.reserveServerDestination();
    if (!reservation) return null;
    pendingInstanceId = reservation.instanceId;
    ownsPendingDestination = true;
    reservedDestinationName = reservation.displayName || 'Selected server destination';
    return pendingInstanceId;
  }

  async function buildPreflight(event, requestedKind = null) {
    busy = true;
    error = null;
    preflightProgress = null;
    destinationNotice = '';
    selectingDestination = !pendingInstanceId;
    try {
      const targetInstanceId = await ensureTargetInstance();
      if (!targetInstanceId) {
        destinationNotice = 'No destination was selected. Choose a folder to continue.';
        return;
      }
      selectingDestination = false;
      destinationNotice = '';
      preflightProgress = { phase: 'validating-destination', percent: 0 };
      reviewedPlan = await modpackApi.preflight({
        inspectionId: inspection.inspectionId,
        instanceId: targetInstanceId,
        operationKind: requestedKind || 'install-new',
        selections: event?.detail?.selections || {
          optionalFileIds: [],
          conflictChoices: {},
          acknowledgeMissingProviderDigest: false,
          acknowledgeDowngradeWorldRisk: false,
          selectedRoot: null,
          runtimeChoice: null,
          maxRam: requestedKind === 'import-files-only-new' ? null : normalizedDefaultMaxRam(defaultMaxRam),
          serverPort: requestedKind === 'import-files-only-new' ? null : normalizedServerPort(defaultServerPort),
          networkAccess: requestedKind === 'import-files-only-new' ? null : 'pack-default'
        }
      }, progress => { preflightProgress = progress; });
    } catch (caught) {
      error = caught;
    } finally {
      selectingDestination = false;
      preflightProgress = null;
      busy = false;
    }
  }

  async function refreshStaleReview() {
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
        releasePendingDestination()
      ]);
    } catch (caught) {
      error = caught;
      busy = false;
      return;
    }
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

  function handleStarted(event) {
    ownsPendingDestination = false;
    job = event.detail.job;
    stage = 'progress';
  }

  function completeSetup(event) {
    const completedJob = event.detail?.job || job;
    if (completedJob?.phase !== 'completed') return;
    dispatch('setup-complete', {
      instanceId: pendingInstanceId,
      modpackJobId: completedJob.jobId,
      source: sourceLabel
    });
  }

  async function goToSource() {
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
    busy = true;
    try {
      await Promise.all([
        discardInspectionSession(abandonedInspection),
        releasePendingDestination()
      ]);
    } catch (caught) {
      error = caught;
    } finally {
      busy = false;
    }
    stage = 'source';
  }

  async function handleOutcomeAction(event) {
    const value = event.detail?.value;
    if (value?.type !== 'outcome-action-result') return;
    const destination = value.destination;
    if (!destination || !['selection', 'asset-selection'].includes(destination.kind)) return;
    const resetDestination = isNewServerDestinationRecoveryOutcome(event.detail?.job?.outcome);
    const abandonedInstanceId = resetDestination ? pendingInstanceId : '';
    if (resetDestination) {
      ownsPendingDestination = false;
      pendingInstanceId = instanceId;
      reservedDestinationName = '';
      if (abandonedInstanceId && abandonedInstanceId !== instanceId) {
        try {
          await releaseDestination(abandonedInstanceId);
        } catch {
          // The operation may already have released it. Local reset must still
          // force a fresh native destination selection on the next preflight.
        }
      }
    }
    job = null;
    await goToSource();
  }

  onDestroy(() => {
    invalidateInspectionRequests();
    const abandonedInspection = inspection;
    inspection = null;
    void discardInspectionSession(abandonedInspection).catch(() => {});
    void releasePendingDestination().catch(() => {});
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
    <ArchiveGuidedReview {inspection} {reviewedPlan} {busy} {error} {preflightProgress} {selectingDestination} {defaultMaxRam} {defaultServerPort} operationKind="install-new" on:preflight={buildPreflight} on:filesonly={(event) => buildPreflight(event, 'import-files-only-new')} on:started={handleStarted} on:stale={refreshStaleReview} on:error={(event) => (error = event.detail.error)} on:back={goToSource} />
    {#if reservedDestinationName}<p class="mp-muted destination-note"><strong>Chosen destination:</strong> {reservedDestinationName}. This safe display name is all this review exposes.</p>{/if}
  {:else if stage === 'progress'}
    <ModpackJobProgress {job} on:terminal={completeSetup} on:action={handleOutcomeAction} on:return={() => { job = null; navigateStage('source'); }} />
  {/if}

  {#if busy && inspectionProgress && !['modrinth', 'github-assets', 'review', 'progress'].includes(stage)}
    <ModpackInspectionProgress progress={inspectionProgress} />
  {/if}
</div>

<style>
  @import '../modpacks/modpack-ui.css';
  .setup-shell { display: grid; gap: 1rem; }
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
