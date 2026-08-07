<script>
  import { createEventDispatcher, onDestroy, tick } from 'svelte';
  import SetupWizard from './SetupWizard.svelte';
  import ModpackSourceChoice from './ModpackSourceChoice.svelte';
  import ModrinthPackBrowser from './ModrinthPackBrowser.svelte';
  import GitHubReleasePicker from './GitHubReleasePicker.svelte';
  import GitHubAssetReview from './GitHubAssetReview.svelte';
  import ArchiveGuidedReview from './ArchiveGuidedReview.svelte';
  import ModpackJobProgress from '../modpacks/ModpackJobProgress.svelte';
  import { modpackApi } from '../../utils/modpacks/modpackApi.js';

  const dispatch = createEventDispatcher();
  export let instanceId = '';

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

  const stepOrder = ['method', 'source', 'select', 'review', 'progress'];
  $: activeStep = stage === 'custom' ? 'method' : ['modrinth', 'github', 'github-assets', 'local'].includes(stage) ? 'select' : stage;
  $: if (stage) focusHeading(stage);

  async function focusHeading() {
    await tick();
    heading?.focus?.();
  }

  function chooseMethod(method) {
    error = null;
    stage = method === 'custom' ? 'custom' : 'source';
  }

  function chooseSource(event) {
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
    suggestedRepositoryUrl = event.detail.repositoryUrl;
    linkedModrinthProjectId = event.detail.modrinthProjectId;
    approvedLinkedModrinthProjectId = null;
    stage = 'github';
  }

  async function selectLocalArchive() {
    busy = true;
    error = null;
    try {
      const selection = await modpackApi.selectLocalArchive(true);
      if (!selection?.selectionId) return;
      await inspectSelection({ provider: 'local', selectionId: selection.selectionId }, selection.displayName || 'Local archive');
    } catch (caught) {
      error = caught;
      stage = 'source';
    } finally {
      busy = false;
    }
  }

  async function inspectSelection(request, label) {
    busy = true;
    error = null;
    selectedRequest = request;
    sourceLabel = label;
    try {
      inspection = await modpackApi.inspect(request);
      reviewedPlan = null;
      stage = 'review';
    } catch (caught) {
      error = caught;
    } finally {
      busy = false;
    }
  }

  function handleGithubAssets(event) {
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
    reservedDestinationName = reservation.displayName || 'Selected server destination';
    return pendingInstanceId;
  }

  async function buildPreflight(event, requestedKind = null) {
    busy = true;
    error = null;
    try {
      const targetInstanceId = await ensureTargetInstance();
      if (!targetInstanceId) return;
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
          runtimeChoice: null
        }
      });
    } catch (caught) {
      error = caught;
    } finally {
      busy = false;
    }
  }

  function handleStarted(event) {
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

  function goToSource() {
    error = null;
    reviewedPlan = null;
    inspection = null;
    githubAssets = null;
    githubRelease = null;
    suggestedRepositoryUrl = '';
    linkedModrinthProjectId = '';
    approvedLinkedModrinthProjectId = null;
    stage = 'source';
  }

  onDestroy(() => {});
</script>

<div class="modpack-surface setup-shell">
  {#if stage !== 'custom'}
    <nav class="stepper" aria-label="Server setup progress">
      {#each stepOrder as stepName, index (stepName)}
        <span class:active={activeStep === stepName} aria-current={activeStep === stepName ? 'step' : undefined}><b>{index + 1}</b>{stepName === 'method' ? 'Method' : stepName === 'source' ? 'Source' : stepName === 'select' ? 'Version or asset' : stepName === 'review' ? 'Review' : 'Install'}</span>
      {/each}
    </nav>
  {/if}

  {#if error && stage !== 'review'}
    <section class="mp-state error global-error" bind:this={heading} tabindex="-1" aria-live="assertive"><strong>{error.code || 'Modpack setup error'}</strong><p>{error.message}</p><button class="mp-button" type="button" on:click={() => { error = null; }}>Dismiss</button></section>
  {:else}
    <span class="mp-sr-only" bind:this={heading} tabindex="-1">Current setup step: {activeStep}</span>
  {/if}

  {#if stage === 'method'}
    <section class="method-panel mp-stack">
      <div><p class="mp-kicker">Create a server</p><h1 class="mp-title">How do you want to set it up?</h1><p class="mp-subtitle">The existing manual setup remains unchanged. Modpacks use exact reviewed sources and transactional installation.</p></div>
      <div class="mp-grid">
        <button type="button" class="mp-card method-card" on:click={() => chooseMethod('custom')} on:keydown={(event) => (event.key === 'Enter' || event.key === ' ') && chooseMethod('custom')}><span class="icon">🛠️</span><strong>Empty/Custom Server</strong><span>Choose Minecraft, loader, Java, and add individual mods yourself.</span><small>Available</small></button>
        <button type="button" class="mp-card method-card" on:click={() => chooseMethod('modpack')} on:keydown={(event) => (event.key === 'Enter' || event.key === ' ') && chooseMethod('modpack')}><span class="icon">📦</span><strong>Install Modpack</strong><span>Browse Modrinth, inspect GitHub Release ZIP/RAR assets, or import a local archive.</span><small>Available</small></button>
      </div>
    </section>
  {:else if stage === 'custom'}
    <div class="custom-flow"><button type="button" class="mp-button back-button" on:click={() => (stage = 'method')}>Back to setup method</button><SetupWizard on:setup-complete={(event) => dispatch('setup-complete', event.detail)} /></div>
  {:else if stage === 'source'}
    <ModpackSourceChoice on:select={chooseSource} on:back={() => (stage = 'method')} />
    {#if busy}<div class="mp-state">Opening the native archive picker…</div>{/if}
  {:else if stage === 'modrinth'}
    <ModrinthPackBrowser on:select={(event) => inspectSelection(event.detail.request, event.detail.label)} on:github={reviewLinkedGithub} on:back={goToSource} on:local={selectLocalArchive} on:custom={() => (stage = 'custom')} />
  {:else if stage === 'github'}
    <GitHubReleasePicker {suggestedRepositoryUrl} suggestedModrinthProjectId={linkedModrinthProjectId} on:assets={handleGithubAssets} on:back={goToSource} on:local={selectLocalArchive} on:custom={() => (stage = 'custom')} />
  {:else if stage === 'github-assets'}
    <GitHubAssetReview release={githubRelease} assetResult={githubAssets} on:select={inspectGithubSelection} on:back={() => (stage = 'github')} on:local={selectLocalArchive} on:custom={() => (stage = 'custom')} />
  {:else if stage === 'review'}
    <ArchiveGuidedReview {inspection} {reviewedPlan} {busy} {error} operationKind="install-new" on:preflight={buildPreflight} on:filesonly={(event) => buildPreflight(event, 'import-files-only-new')} on:started={handleStarted} on:error={(event) => (error = event.detail.error)} on:back={goToSource} />
    {#if reservedDestinationName}<p class="mp-muted destination-note">Destination reserved: {reservedDestinationName}</p>{/if}
  {:else if stage === 'progress'}
    <ModpackJobProgress {job} on:terminal={completeSetup} on:return={() => { job = null; stage = 'source'; }} />
  {/if}
</div>

<style>
  @import '../modpacks/modpack-ui.css';
  .setup-shell { display: grid; gap: 1rem; }
  .stepper { display: grid; grid-template-columns: repeat(5, minmax(0, 1fr)); gap: 0.35rem; padding: 0.55rem; border: 1px solid var(--mp-border); border-radius: 10px; background: rgba(0, 0, 0, 0.16); }
  .stepper span { display: flex; align-items: center; justify-content: center; gap: 0.4rem; min-height: 38px; padding: 0.25rem; color: var(--mp-muted); font-size: 0.8rem; text-align: center; border-radius: 7px; }
  .stepper span b { display: inline-grid; place-items: center; width: 1.35rem; height: 1.35rem; border-radius: 999px; border: 1px solid var(--mp-border); }
  .stepper span.active { background: rgba(124, 131, 255, 0.13); color: white; }
  .stepper span.active b { background: var(--mp-accent-strong); border-color: var(--mp-accent-strong); }
  .method-panel { padding: clamp(0.5rem, 3vw, 2rem); }
  .method-card { display: grid; align-content: start; min-height: 220px; gap: 0.8rem; color: inherit; text-align: left; font: inherit; cursor: pointer; }
  .method-card:hover, .method-card:focus-visible { border-color: rgba(124, 131, 255, 0.72); transform: translateY(-2px); }
  .method-card .icon { font-size: 2rem; }
  .method-card strong { font-size: 1.2rem; }
  .method-card > span:not(.icon) { color: var(--mp-muted); }
  .method-card small { color: var(--mp-good); }
  .custom-flow { position: relative; }
  .back-button { margin-bottom: 0.8rem; }
  .global-error { margin-bottom: 0.2rem; }
  .destination-note { margin: 0; }
  @media (max-width: 700px) { .stepper { grid-template-columns: 1fr; } .stepper span { justify-content: flex-start; } }
</style>
