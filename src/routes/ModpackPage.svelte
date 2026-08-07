<script>
  import { onDestroy, onMount, tick } from 'svelte';
  import { modpackApi } from '../utils/modpacks/modpackApi.js';
  import ModpackOverview from '../components/modpacks/ModpackOverview.svelte';
  import ModpackVersionPanel from '../components/modpacks/ModpackVersionPanel.svelte';
  import ModpackActionPanel from '../components/modpacks/ModpackActionPanel.svelte';
  import ModpackPlanReview from '../components/modpacks/ModpackPlanReview.svelte';
  import ModpackJobProgress from '../components/modpacks/ModpackJobProgress.svelte';
  import ModpackRecoveryPanel from '../components/modpacks/ModpackRecoveryPanel.svelte';
  import ModpackNotificationCenter from '../components/modpacks/ModpackNotificationCenter.svelte';
  import { filterRecoveryRecordsForServer } from '../stores/modpackNotificationStore.js';
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
  let loading = true;
  let error = null;
  let activeSection = 'overview';
  let flow = 'dashboard';
  let operationKind = 'install-existing';
  let inspection = null;
  let reviewedPlan = null;
  let githubRelease = null;
  let githubAssets = null;
  let suggestedRepositoryUrl = '';
  let linkedModrinthProjectId = '';
  let currentGithubReleaseId = '';
  let approvedLinkedModrinthProjectId = null;
  let job = null;
  let verification = null;
  let busy = false;
  let cleanups = [];
  let selectedRestorePointId = null;
  let handledNavigationToken = null;
  let pageRoot;
  let errorRegion;
  let focusedFlow = null;
  let focusedError = null;
  let contextualNotificationSequence = 0;

  $: serverId = currentInstance?.id || '';
  $: isManaged = Boolean(state?.modpackManaged);
  $: recoveryItems = Array.isArray(recovery) ? recovery : recovery?.items || [];
  $: currentServerRecoveryItems = filterRecoveryRecordsForServer(recoveryItems, serverId);
  $: restorePoints = history.filter(item => item.restorePointId);
  $: if (navigationTarget?.token && navigationTarget.token !== handledNavigationToken) {
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
    const target = [...pageRoot.querySelectorAll('h2, h3')].find(element => element.offsetParent !== null);
    if (!target) return;
    target.setAttribute('tabindex', '-1');
    target.focus();
  }

  async function focusError(expectedError) {
    await tick();
    if (error !== expectedError) return;
    errorRegion?.focus?.();
  }

  function applyNavigationTarget(target) {
    handledNavigationToken = target.token;
    if (target.serverId && serverId && target.serverId !== serverId) return;
    const type = target.notificationType;
    const destinationKind = target.result?.destination?.kind || '';
    flow = 'dashboard';
    error = null;
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

  async function refresh() {
    if (!serverId) return;
    loading = true;
    error = null;
    try {
      const [nextState, historyPage, recoveryRecords] = await Promise.all([
        modpackApi.getState(serverId),
        modpackApi.listHistory(serverId, null, 50),
        modpackApi.listRecovery()
      ]);
      state = nextState;
      history = historyPage?.items || [];
      historyCursor = historyPage?.nextCursor || null;
      recovery = recoveryRecords || [];
    } catch (caught) {
      error = caught;
    } finally {
      loading = false;
    }
  }

  async function loadOlderHistory() {
    if (!historyCursor) return;
    busy = true;
    try {
      const page = await modpackApi.listHistory(serverId, historyCursor, 50);
      history = [...history, ...(page?.items || [])];
      historyCursor = page?.nextCursor || null;
    } catch (caught) {
      error = caught;
    } finally {
      busy = false;
    }
  }

  function beginSource(kind = isManaged ? 'switch' : 'install-existing') {
    operationKind = kind;
    inspection = null;
    reviewedPlan = null;
    error = null;
    suggestedRepositoryUrl = '';
    linkedModrinthProjectId = '';
    currentGithubReleaseId = '';
    approvedLinkedModrinthProjectId = null;
    flow = 'source';
  }

  function reviewLinkedGithub(event) {
    suggestedRepositoryUrl = event.detail.repositoryUrl;
    linkedModrinthProjectId = event.detail.modrinthProjectId;
    currentGithubReleaseId = '';
    approvedLinkedModrinthProjectId = null;
    flow = 'github';
  }

  function reviewManagedGithub(event) {
    suggestedRepositoryUrl = event.detail.repositoryUrl;
    linkedModrinthProjectId = '';
    currentGithubReleaseId = event.detail.currentReleaseId;
    approvedLinkedModrinthProjectId = null;
    flow = 'github';
  }

  function handleGithubAssets(event) {
    githubRelease = event.detail.release;
    githubAssets = event.detail.assets;
    approvedLinkedModrinthProjectId = event.detail.linkedModrinthProjectId || null;
    if (event.detail.operationKind && operationKind !== 'repair') operationKind = event.detail.operationKind;
    flow = 'github-assets';
  }

  function inspectGithubSelection(event) {
    return inspectSelection({
      ...event.detail.request,
      rememberAssetPattern: Boolean(event.detail.rememberPattern),
      ...(approvedLinkedModrinthProjectId ? { linkedModrinthProjectId: approvedLinkedModrinthProjectId } : {})
    }, operationKind);
  }

  async function selectLocalArchive() {
    const requestedOperationKind = operationKind;
    busy = true;
    error = null;
    try {
      const selection = await modpackApi.selectLocalArchive(true);
      if (selection?.selectionId) await inspectSelection({ provider: 'local', selectionId: selection.selectionId }, requestedOperationKind);
    } catch (caught) {
      error = caught;
    } finally {
      busy = false;
    }
  }

  async function inspectSelection(request, forcedOperation = null) {
    busy = true;
    error = null;
    if (forcedOperation) operationKind = forcedOperation;
    try {
      inspection = await modpackApi.inspect(request);
      reviewedPlan = null;
      flow = 'inspection';
    } catch (caught) {
      error = caught;
    } finally {
      busy = false;
    }
  }

  async function buildPreflight(event, kind = operationKind) {
    busy = true;
    error = null;
    try {
      reviewedPlan = await modpackApi.preflight({
        inspectionId: inspection.inspectionId,
        instanceId: serverId,
        operationKind: kind,
        selections: event?.detail?.selections || {
          optionalFileIds: [], conflictChoices: {}, acknowledgeMissingProviderDigest: false,
          acknowledgeDowngradeWorldRisk: false, selectedRoot: null, runtimeChoice: null
        }
      });
      flow = reviewedPlan?.requiresConflictReview === true ? 'inspection' : 'review';
    } catch (caught) {
      error = caught;
    } finally {
      busy = false;
    }
  }

  async function beginManagedOperation(kind) {
    operationKind = kind;
    error = null;
    if (kind === 'rollback-restore-point') {
      selectedRestorePointId = null;
      flow = 'restore-points';
      return;
    }
    await buildManagementPlan(kind, null);
  }

  async function buildManagementPlan(kind, selectionRef) {
    busy = true;
    error = null;
    try {
      reviewedPlan = await modpackApi.preflightManagement(serverId, kind, selectionRef);
      operationKind = kind;
      selectedRestorePointId = kind === 'rollback-restore-point' ? selectionRef : null;
      flow = 'review';
    } catch (caught) {
      error = caught;
    } finally {
      busy = false;
    }
  }

  async function verifyModpack() {
    busy = true;
    error = null;
    try {
      verification = await modpackApi.verify(serverId);
      job = verification;
      flow = 'job';
    } catch (caught) {
      error = caught;
    } finally {
      busy = false;
    }
  }

  function handleStarted(event) {
    job = event.detail.job;
    flow = 'job';
  }

  async function handleOutcomeAction(event) {
    const value = event.detail.value;
    if (value?.type !== 'outcome-action-result') return;
    const destination = value?.destination;
    if (!destination && !value?.operationRef) {
      if (['removed', 'retained'].includes(value?.status)) await refresh();
      return;
    }

    if (value.operationRef) {
      if (event.detail.actionId === 'retry') {
        try {
          job = await modpackApi.getJob(value.operationRef);
          flow = 'job';
        } catch (caught) {
          error = caught;
        }
      } else {
        flow = 'dashboard';
        activeSection = 'recovery';
        job = null;
        await refresh();
      }
      return;
    }

    if (['selection', 'asset-selection'].includes(destination.kind)) {
      beginSource();
      return;
    }

    flow = 'dashboard';
    reviewedPlan = null;
    inspection = null;
    job = null;
    if (destination.kind === 'details' || destination.kind === 'restore-point') activeSection = 'history';
    else if (destination.kind === 'recovery') activeSection = 'recovery';
    else if (destination.kind === 'server') activeSection = 'overview';
    else return;
    await refresh();
  }

  function returnToDashboard() {
    flow = 'dashboard';
    reviewedPlan = null;
    inspection = null;
    job = null;
    refresh();
  }

  onMount(() => {
    cleanups = [modpackApi.onStateChanged(event => {
      if (event?.instanceId === serverId || event?.serverId === serverId) refresh();
    })];
    refresh();
  });
  onDestroy(() => cleanups.forEach(cleanup => cleanup()));
</script>

<div class="modpack-surface modpack-page mp-stack" bind:this={pageRoot}>
  <header class="page-header mp-toolbar">
    <div class="grow"><p class="mp-kicker">Server lifecycle</p><h1 class="mp-title">Modpack</h1><p class="mp-subtitle">Install, verify, update, downgrade, switch, repair, roll back, detach, or uninstall with reviewed durable transactions.</p></div>
    <div class="page-actions">
      {#if flow !== 'dashboard'}
        <button class="mp-button" type="button" on:click={returnToDashboard}>Back to Modpack overview</button>
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

  {#if currentServerRecoveryItems.length > 0}<ModpackRecoveryPanel {serverId} records={currentServerRecoveryItems} on:recovered={refresh} />{/if}

  {#if flow === 'dashboard'}
    <nav class="section-tabs" aria-label="Modpack sections">
      {#each ['overview', 'versions', 'actions', 'history', 'recovery'] as section (section)}<button type="button" class:active={activeSection === section} aria-current={activeSection === section ? 'page' : undefined} on:click={() => (activeSection = section)}>{section === 'overview' ? 'Overview' : section === 'versions' ? 'Versions' : section === 'actions' ? 'Actions' : section === 'history' ? 'History' : 'Recovery'}</button>{/each}
    </nav>
    {#if activeSection === 'overview'}<ModpackOverview {state} {loading} on:install={() => beginSource('install-existing')} on:filesonly={() => beginSource('import-files-only-new')} />
    {:else if activeSection === 'versions'}<ModpackVersionPanel {state} on:select={(event) => inspectSelection(event.detail.request, event.detail.operationKind)} on:github={reviewManagedGithub} on:switch={() => beginSource('switch')} />
    {:else if activeSection === 'actions'}<ModpackActionPanel {state} {busy} {verification} on:verify={verifyModpack} on:repair={() => beginSource('repair')} on:rollback={() => beginManagedOperation('rollback-restore-point')} on:detach={() => beginManagedOperation('detach')} on:uninstall={() => beginManagedOperation('uninstall')} />
    {:else if activeSection === 'history'}
      <section class="mp-panel mp-stack" aria-label="Modpack history"><div><p class="mp-kicker">Durable audit history</p><h2 class="mp-title">Lifecycle operations</h2><p class="mp-subtitle">Managed files and user additions remain distinguished in every recorded revision.</p></div>{#if history.length === 0}<div class="mp-state">No modpack history has been recorded for this server.</div>{:else}<ol class="history-list">{#each history as item (`${item.operationId}-${item.sequence}`)}<li><div><strong>{item.kind?.replaceAll('-', ' ') || 'operation'}</strong><span>{item.outcome || 'recorded'} · {new Date(item.timestamp).toLocaleString()}</span></div><span class="mp-badge">revision {item.sourceRevision ?? '—'} → {item.targetRevision ?? '—'}</span></li>{/each}</ol>{/if}{#if historyCursor}<button class="mp-button" type="button" on:click={loadOlderHistory} disabled={busy}>Load older history</button>{/if}</section>
    {:else}<ModpackRecoveryPanel {serverId} records={currentServerRecoveryItems} on:recovered={refresh} />{/if}
  {:else if flow === 'source'}
    <ModpackSourceChoice on:select={(event) => event.detail.source === 'local' ? selectLocalArchive() : (flow = event.detail.source)} on:back={returnToDashboard} />
  {:else if flow === 'modrinth'}
    <ModrinthPackBrowser on:select={(event) => inspectSelection(event.detail.request, operationKind)} on:github={reviewLinkedGithub} on:back={() => (flow = 'source')} on:local={selectLocalArchive} on:custom={returnToDashboard} />
  {:else if flow === 'github'}
    <GitHubReleasePicker {serverId} {suggestedRepositoryUrl} suggestedModrinthProjectId={linkedModrinthProjectId} currentReleaseId={currentGithubReleaseId} on:assets={handleGithubAssets} on:back={() => (flow = 'source')} on:local={selectLocalArchive} on:custom={returnToDashboard} />
  {:else if flow === 'github-assets'}
    <GitHubAssetReview release={githubRelease} assetResult={githubAssets} on:select={inspectGithubSelection} on:back={() => (flow = 'github')} on:local={selectLocalArchive} on:custom={returnToDashboard} />
  {:else if flow === 'inspection'}
    <ArchiveGuidedReview {inspection} {reviewedPlan} {busy} {error} {operationKind} on:preflight={buildPreflight} on:filesonly={(event) => buildPreflight(event, 'import-files-only-new')} on:started={handleStarted} on:error={(event) => (error = event.detail.error)} on:back={() => (flow = 'source')} />
  {:else if flow === 'restore-points'}
    <section class="mp-panel mp-stack" aria-label="Choose a restore point"><div><p class="mp-kicker">Exact rollback source</p><h2 class="mp-title">Choose a compatible restore point</h2><p class="mp-subtitle">Rollback reconstructs a fresh candidate from one pinned restore point. No binary-only world downgrade is offered.</p></div>{#if restorePoints.length === 0}<div class="mp-state warning"><strong>No compatible restore point is listed</strong><p>Create or retain a verified restore point before attempting rollback.</p></div>{:else}<ul class="mp-list">{#each restorePoints as item (item.restorePointId)}<li><button class="mp-row" type="button" disabled={busy} on:click={() => buildManagementPlan('rollback-restore-point', item.restorePointId)}><span><strong>{item.kind?.replaceAll('-', ' ')} restore point</strong><br /><span class="mp-muted">Created {new Date(item.timestamp).toLocaleString()} · source revision {item.sourceRevision}</span></span><span class="mp-badge good">Verified record</span></button></li>{/each}</ul>{/if}</section>
  {:else if flow === 'review'}
    <ModpackPlanReview {reviewedPlan} {operationKind} {busy} restorePointId={selectedRestorePointId} on:started={handleStarted} on:cancel={() => (flow = inspection ? 'inspection' : 'dashboard')} />
  {:else if flow === 'job'}
    <ModpackJobProgress {job} on:return={returnToDashboard} on:terminal={(event) => { if (event.detail.job.operationKind === 'verify') verification = event.detail.job; }} on:action={handleOutcomeAction} />
  {/if}
</div>

<style>
  @import '../components/modpacks/modpack-ui.css';
  .modpack-page { padding: 0.5rem 0 2rem; }
  .page-header { padding: 0.4rem 0; }
  .page-actions { display: flex; align-items: center; justify-content: flex-end; gap: 0.55rem; min-height: 42px; }
  .section-tabs { display: flex; gap: 0.45rem; overflow-x: auto; padding: 0.4rem; border: 1px solid var(--mp-border); border-radius: 10px; background: rgba(0, 0, 0, 0.15); }
  .section-tabs button { flex: 1 0 auto; min-width: 110px; border: 1px solid transparent; border-radius: 7px; padding: 0.6rem 0.8rem; background: transparent; color: var(--mp-muted); }
  .section-tabs button.active { color: white; background: rgba(124, 131, 255, 0.15); border-color: rgba(124, 131, 255, 0.35); }
  .history-list { display: grid; gap: 0.55rem; padding: 0; margin: 0; list-style: none; }
  .history-list li { display: flex; justify-content: space-between; align-items: center; gap: 0.7rem; padding: 0.75rem; border: 1px solid var(--mp-border); border-radius: 8px; background: var(--mp-panel-soft); }
  .history-list li div { display: grid; gap: 0.2rem; }
  .history-list li span:not(.mp-badge) { color: var(--mp-muted); font-size: 0.86rem; }
</style>
