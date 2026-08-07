<script>
  import { createEventDispatcher } from 'svelte';
  import { modpackApi } from '../../utils/modpacks/modpackApi.js';

  const dispatch = createEventDispatcher();
  export let inspection;
  export let reviewedPlan = null;
  export let busy = false;
  export let error = null;
  export let operationKind = 'install-existing';

  let acceptEula = false;
  let startAfterInstall = true;
  let acknowledgeMissingProviderDigest = false;
  let acknowledgeDowngradeWorldRisk = false;
  let optionalFileIds = [];
  let conflictChoices = { paths: {}, categories: {} };
  let selectedRoot = null;
  let runtimeChoice = null;
  let runtimeMinecraftVersion = '';
  let runtimeLoaderFamily = '';
  let runtimeLoaderVersion = '';
  let selectionInspectionId = null;
  let starting = false;

  $: rootCandidates = inspection?.rootCandidates || [];
  $: detectedRuntime = cleanRuntimeChoice(inspection?.classification?.runtime);
  $: runtimeCandidates = inspection?.classification?.runtimeCandidates || inspection?.classification?.candidates?.filter(candidate => cleanRuntimeChoice(candidate)) || [];
  $: loaderChoices = [...new Set([
    ...((inspection?.classification?.candidates || []).map(candidate => candidate?.loaderFamily).filter(Boolean)),
    'vanilla', 'fabric', 'forge', 'neoforge', 'quilt'
  ])];
  $: optionalFiles = inspection?.classification?.optionalFiles || [];
  $: conflictReview = reviewedPlan?.requiresConflictReview === true;
  $: conflicts = conflictReview && Array.isArray(reviewedPlan?.conflicts) ? reviewedPlan.conflicts : [];
  $: if ((inspection?.inspectionId || null) !== selectionInspectionId) resetInspectionSelections(inspection);
  $: runtimeChoice = cleanRuntimeChoice({
    minecraftVersion: runtimeMinecraftVersion,
    loaderFamily: runtimeLoaderFamily,
    loaderVersion: runtimeLoaderVersion
  });
  $: missingDigest = Boolean(inspection?.warnings?.some?.(warning => warning.code === 'MISSING_PROVIDER_DIGEST') || reviewedPlan?.planView?.warnings?.some?.(warning => warning.code === 'MISSING_PROVIDER_DIGEST'));
  $: rootChoiceRequired = !inspection?.selectedRoot && rootCandidates.length > 1;
  $: runtimeChoiceRequired = !rootChoiceRequired && !detectedRuntime && inspection?.classification?.kind === 'ambiguous-or-unknown';
  $: classificationStillUnknown = inspection?.classification?.blocked === true && !rootChoiceRequired && !runtimeChoiceRequired;
  $: unresolvedAmbiguity = (rootChoiceRequired && !selectedRoot) || (runtimeChoiceRequired && !runtimeChoice) || classificationStillUnknown;
  $: hardConflictBlocker = conflicts.some(conflict => !Array.isArray(conflict.allowedChoices) || conflict.allowedChoices.length === 0);
  $: conflictsResolved = !conflictReview || (!hardConflictBlocker && conflicts.every(conflict => {
    const decision = conflictChoices.paths?.[conflict.id];
    return Boolean(decision && conflict.allowedChoices?.includes(decision.choice) &&
      (decision.choice !== 'keep-both' || typeof decision.alternateId === 'string'));
  }));
  $: filesOnlyEligible = ['files-only', 'ambiguous-or-unknown', 'unsupported-runtime-layout'].includes(inspection?.classification?.kind);
  $: blockers = reviewedPlan?.planView?.blockers || [];
  $: canPreflight = !unresolvedAmbiguity && conflictsResolved && (!missingDigest || acknowledgeMissingProviderDigest);
  $: canFilesOnly = operationKind !== 'repair' && filesOnlyEligible && (!rootChoiceRequired || Boolean(selectedRoot)) && (!missingDigest || acknowledgeMissingProviderDigest);
  $: canStart = Boolean(reviewedPlan?.planId && reviewedPlan?.planFingerprint && blockers.length === 0 && acceptEula && (!missingDigest || acknowledgeMissingProviderDigest));
  $: plan = reviewedPlan?.planView || {};
  $: changes = plan.changes || {};

  function rootLabel(candidate) {
    return typeof candidate === 'string' ? candidate : '';
  }

  function cleanRuntimeChoice(candidate) {
    if (!candidate) return null;
    const { minecraftVersion, loaderFamily, loaderVersion } = candidate;
    if (typeof minecraftVersion !== 'string' || !/^\d+\.\d+(?:\.\d+)?(?:-[A-Za-z0-9._-]+)?$/.test(minecraftVersion) ||
        !['vanilla', 'fabric', 'forge', 'neoforge', 'quilt'].includes(loaderFamily) ||
        typeof loaderVersion !== 'string' || !/^[A-Za-z0-9][A-Za-z0-9._+-]{0,127}$/.test(loaderVersion)) return null;
    return { minecraftVersion, loaderFamily, loaderVersion };
  }

  function runtimeLabel(candidate) {
    const value = cleanRuntimeChoice(candidate);
    return value ? `Minecraft ${value.minecraftVersion} · ${value.loaderFamily} ${value.loaderVersion}` : 'Incomplete runtime evidence';
  }

  function resetInspectionSelections(nextInspection) {
    selectionInspectionId = nextInspection?.inspectionId || null;
    const roots = nextInspection?.rootCandidates || [];
    optionalFileIds = (nextInspection?.classification?.optionalFiles || [])
      .filter(item => item?.defaultSelected === true)
      .map(item => item.id);
    selectedRoot = typeof nextInspection?.selectedRoot === 'string'
      ? nextInspection.selectedRoot
      : roots.length === 1 ? rootLabel(roots[0]) : null;
    const runtimes = nextInspection?.classification?.runtimeCandidates || [];
    const suggestedRuntime = runtimes.length === 1 ? cleanRuntimeChoice(runtimes[0]) : null;
    runtimeMinecraftVersion = suggestedRuntime?.minecraftVersion || '';
    runtimeLoaderFamily = suggestedRuntime?.loaderFamily || '';
    runtimeLoaderVersion = suggestedRuntime?.loaderVersion || '';
    conflictChoices = { paths: {}, categories: {} };
  }

  function conflictDecision(conflictId) {
    return conflictChoices.paths?.[conflictId] || null;
  }

  function chooseConflict(conflict, choice) {
    const prior = conflictDecision(conflict.id);
    const next = choice ? { choice, ...(choice === 'keep-both' && prior?.alternateId ? { alternateId: prior.alternateId } : {}) } : null;
    const paths = { ...conflictChoices.paths };
    if (next) paths[conflict.id] = next;
    else delete paths[conflict.id];
    conflictChoices = { ...conflictChoices, paths };
  }

  function chooseConflictAlternate(conflict, alternateId) {
    const decision = conflictDecision(conflict.id);
    if (decision?.choice !== 'keep-both') return;
    conflictChoices = {
      ...conflictChoices,
      paths: { ...conflictChoices.paths, [conflict.id]: { choice: 'keep-both', ...(alternateId ? { alternateId } : {}) } }
    };
  }

  function choiceLabel(choice) {
    return {
      'keep-mine': 'Keep my file',
      'use-pack': 'Use the pack file',
      'keep-both': 'Keep both',
      'disable-addon': 'Disable the conflicting add-on',
      'remove-addon': 'Remove the conflicting add-on'
    }[choice] || choice;
  }

  function planningSelections() {
    return {
      optionalFileIds,
      conflictChoices,
      acknowledgeMissingProviderDigest,
      ...(operationKind === 'downgrade' ? { acknowledgeDowngradeWorldRisk } : { acknowledgeDowngradeWorldRisk: false }),
      selectedRoot,
      runtimeChoice: cleanRuntimeChoice(runtimeChoice)
    };
  }

  function requestPreflight() {
    if (!canPreflight) return;
    dispatch('preflight', { selections: planningSelections() });
  }

  function requestFilesOnlyPreflight() {
    if (!canFilesOnly) return;
    dispatch('filesonly', { selections: { ...planningSelections(), runtimeChoice: null } });
  }

  async function startReviewedPlan() {
    if (!canStart) return;
    starting = true;
    try {
      const { planId, planFingerprint } = reviewedPlan;
      const choices = { acceptEula, startAfterInstall, restorePointId: null };
      const job = await modpackApi.startOperation({ planId, planFingerprint, choices });
      dispatch('started', { job });
    } catch (caught) {
      dispatch('error', { error: caught });
    } finally {
      starting = false;
    }
  }

  function count(value) {
    return value ?? 0;
  }
</script>

<div class="modpack-surface mp-stack">
  <div class="mp-toolbar"><div class="grow"><p class="mp-kicker">Guided archive review</p><h2 class="mp-title">Inspect evidence before installation</h2><p class="mp-subtitle">No server write occurs until this exact plan is accepted and started.</p></div><button type="button" class="mp-button" on:click={() => dispatch('back')}>Choose another asset</button></div>

  {#if error}<section class="mp-state error" tabindex="-1" aria-live="assertive"><strong>Review could not continue</strong><p>{error.message}</p></section>{/if}

  <section class="mp-grid" aria-label="Archive inspection evidence">
    <div class="mp-card mp-metric"><span class="mp-muted">Integrity</span><strong>{inspection?.integrity || 'Not tested'}</strong><span class="mp-muted">{inspection?.archiveFamily || 'Unknown'} archive</span></div>
    <div class="mp-card mp-metric"><span class="mp-muted">Archive tree</span><strong>{inspection?.limitEvidence?.totals?.entryCount || inspection?.entries?.length || 0} files</strong><span class="mp-muted">{inspection?.limitEvidence?.totals?.expandedBytes || 'Unknown'} expanded bytes</span></div>
    <div class="mp-card mp-metric"><span class="mp-muted">Classification</span><strong>{inspection?.classification?.kind || 'Unknown package'}</strong><span class="mp-muted">{inspection?.classification?.confidence || 'No confidence'} evidence</span></div>
    <div class="mp-card mp-metric"><span class="mp-muted">Proposed root</span><strong>{selectedRoot || 'Archive root'}</strong><span class="mp-muted">{rootCandidates.length} root candidate{rootCandidates.length === 1 ? '' : 's'}</span></div>
  </section>

  <section class="mp-panel mp-stack">
    <div><h3>Runtime and Java evidence</h3><p class="mp-muted">Minecraft {plan.runtime?.minecraft || detectedRuntime?.minecraftVersion || runtimeChoice?.minecraftVersion || 'not identified'} · {plan.runtime?.loader || detectedRuntime?.loaderFamily || runtimeChoice?.loaderFamily || 'loader not identified'} {plan.runtime?.loaderVersion || detectedRuntime?.loaderVersion || runtimeChoice?.loaderVersion || ''} · Java {plan.runtime?.java || inspection?.classification?.runtime?.javaMajor || 'derived after selection'}</p></div>
    {#if rootChoiceRequired}
      <fieldset class="choice-list"><legend>Choose the server root</legend>{#each rootCandidates as candidate (rootLabel(candidate))}<label><input type="radio" name="archive-root" bind:group={selectedRoot} value={rootLabel(candidate)} /><span><strong>{rootLabel(candidate)}</strong><small>Use this archive directory as the server root.</small></span></label>{/each}</fieldset>
    {/if}
    {#if runtimeChoiceRequired}
      <fieldset class="choice-list runtime-fields"><legend>Enter the exact runtime</legend><label><span><strong>Minecraft version</strong><small>Use the exact version declared by the pack publisher.</small></span><input type="text" bind:value={runtimeMinecraftVersion} placeholder="1.21.1" /></label><label><span><strong>Loader family</strong><small>Select the exact supported loader family.</small></span><select bind:value={runtimeLoaderFamily}><option value="">Select loader</option>{#each loaderChoices as loader (loader)}<option value={loader}>{loader}</option>{/each}</select></label><label><span><strong>Loader version</strong><small>Use the exact loader version declared by the pack publisher.</small></span><input type="text" bind:value={runtimeLoaderVersion} placeholder="0.16.14" /></label><p class="mp-muted">Java, operating system, and architecture are derived and validated by the main process.</p></fieldset>
    {/if}
    {#if optionalFiles.length > 0}
      <fieldset class="choice-list"><legend>Optional pack files</legend>{#each optionalFiles as item (item.id)}<label><input type="checkbox" bind:group={optionalFileIds} value={item.id} /><span><strong>{item.label}</strong><small>{item.defaultSelected ? 'Included by the pack by default.' : 'Not included unless selected.'}</small></span></label>{/each}</fieldset>
    {/if}
    {#if conflictReview}
      <section class="conflict-review mp-stack" aria-label="Conflict choices"><div><h3>Resolve detected server conflicts</h3><p class="mp-muted">These opaque choices came from the main-process ownership review. No filesystem path is exposed to this page.</p></div>{#each conflicts as conflict (conflict.id)}<fieldset class="choice-list"><legend>{conflict.label}</legend><p class="mp-muted">{conflict.role} · {conflict.reason}{conflict.protected ? ' · protected content' : ''}</p>{#if !conflict.allowedChoices?.length}<div class="mp-state error"><strong>Structural conflict cannot be overridden</strong><p>Choose another archive or change the server contents before retrying.</p></div>{:else}<label><span><strong>Resolution</strong></span><select aria-label={`Resolution for ${conflict.label}`} value={conflictDecision(conflict.id)?.choice || ''} on:change={(event) => chooseConflict(conflict, event.target.value)}><option value="">Choose a resolution</option>{#each conflict.allowedChoices as choice (choice)}<option value={choice}>{choiceLabel(choice)}</option>{/each}</select></label>{#if conflictDecision(conflict.id)?.choice === 'keep-both'}<label><span><strong>Alternate destination</strong></span><select aria-label={`Alternate destination for ${conflict.label}`} value={conflictDecision(conflict.id)?.alternateId || ''} on:change={(event) => chooseConflictAlternate(conflict, event.target.value)}><option value="">Choose an approved alternate</option>{#each conflict.alternateOptions || [] as alternate (alternate.id)}<option value={alternate.id}>{alternate.label}</option>{/each}</select></label>{/if}{/if}</fieldset>{/each}</section>
    {/if}
    {#if unresolvedAmbiguity}<div class="mp-state error"><strong>Unresolved ambiguity blocks installation</strong><p>Select one safe server root and one exact runtime where offered. If the remaining evidence is still conflicting, choose another asset; Minecraft Core will not guess.</p></div>{/if}
    {#if missingDigest}<label class="acknowledgement"><input type="checkbox" bind:checked={acknowledgeMissingProviderDigest} /><span><strong>Missing digest acknowledgement</strong><br /><small>The provider did not publish a trustworthy digest. Minecraft Core will still calculate and pin its own SHA-256 after download.</small></span></label>{/if}
    {#if operationKind === 'downgrade'}<label class="acknowledgement"><input type="checkbox" bind:checked={acknowledgeDowngradeWorldRisk} /><span>I understand a world downgrade requires a compatible verified restore point.</span></label>{/if}
  </section>

  {#if !reviewedPlan || conflictReview}
    <section class="mp-panel mp-stack">
      <div><h3>{conflictReview ? 'Review conflict resolutions' : 'Build the exact server plan'}</h3><p class="mp-muted">The preflight checks ownership, conflicts, runtime construction, Java, disk space, protected paths, writes, removals, and preservation without changing the server.</p></div>
      <div class="mp-actions"><button type="button" class="mp-button primary" disabled={!canPreflight || busy} on:click={requestPreflight}>{busy ? 'Planning…' : conflictReview ? 'Re-run preflight with conflict choices' : 'Run preflight review'}</button>{#if !conflictReview}<button type="button" class="mp-button" on:click={requestFilesOnlyPreflight} disabled={!canFilesOnly || busy}>Import safely as unmanaged files-only</button>{/if}</div>
    </section>
  {:else}
    <section class="mp-panel mp-stack" aria-label="Reviewed modpack plan">
      <div><p class="mp-kicker">Exact reviewed plan</p><h3>{plan.title || 'Modpack installation'}</h3><p class="mp-muted">{plan.source?.provider || 'Reviewed source'} · version {plan.source?.version || 'exact selection'} · server revision {plan.server?.contentRevision ?? 'new'}</p></div>
      <div class="mp-grid" aria-label="File diff summary">
        <div class="mp-card mp-metric"><span class="mp-muted">Files added</span><strong>{count(changes.added)}</strong></div>
        <div class="mp-card mp-metric"><span class="mp-muted">Files changed</span><strong>{count(changes.changed)}</strong></div>
        <div class="mp-card mp-metric"><span class="mp-muted">Files removed</span><strong>{count(changes.removed)}</strong></div>
        <div class="mp-card mp-metric"><span class="mp-muted">Files preserved</span><strong>{count(changes.preserved)}</strong></div>
      </div>
      <div class="mp-split">
        <div class="mp-card"><strong>Ownership and conflicts</strong><p class="mp-muted">Pack-managed and runtime-managed files are tracked separately from user-owned additions. Protected worlds, secrets, modified files, and unresolved conflicts are preserved or block the plan.</p></div>
        <div class="mp-card"><strong>Planned work</strong><p class="mp-muted">Verified downloads, safe extraction, runtime and Java configuration, candidate validation, directory commit, final-path health validation, and rollback cleanup.</p></div>
      </div>
      {#if plan.warnings?.length}<div class="mp-state warning"><strong>Warnings require review</strong><ul>{#each plan.warnings as warning, index (index)}<li>{warning.message || warning.code || warning}</li>{/each}</ul></div>{/if}
      {#if blockers.length}<div class="mp-state error"><strong>Plan has unresolved blockers</strong><ul>{#each blockers as blocker, index (index)}<li>{blocker.message || blocker.code || blocker}</li>{/each}</ul></div>{/if}
      <label class="acknowledgement"><input type="checkbox" bind:checked={acceptEula} /><span><strong>I accept the Minecraft EULA</strong><br /><small>Pack-supplied EULA files are ignored; this explicit choice controls application-owned acceptance.</small></span></label>
      <label class="acknowledgement"><input type="checkbox" bind:checked={startAfterInstall} /><span>Start after install and validate final health</span></label>
      <div class="mp-actions"><button type="button" class="mp-button primary" disabled={!canStart || busy || starting} on:click={startReviewedPlan}>{starting ? 'Starting…' : 'Install this exact reviewed plan'}</button></div>
    </section>
  {/if}
</div>

<style>
  @import '../modpacks/modpack-ui.css';
  h3 { margin: 0 0 0.35rem; }
  .acknowledgement { display: flex; gap: 0.65rem; align-items: flex-start; }
  .acknowledgement input { margin-top: 0.25rem; }
  .choice-list { display: grid; gap: 0.55rem; margin: 0; padding: 0.8rem; border: 1px solid var(--mp-border); border-radius: 8px; }
  .choice-list legend { padding: 0 0.35rem; font-weight: 700; }
  .choice-list label { display: flex; gap: 0.6rem; align-items: flex-start; }
  .choice-list label span { display: grid; gap: 0.15rem; }
  .choice-list small { color: var(--mp-muted); }
  .choice-list select, .choice-list input[type='text'] { min-width: min(100%, 18rem); padding: 0.55rem; color: inherit; background: rgba(0, 0, 0, 0.24); border: 1px solid var(--mp-border); border-radius: 6px; }
  .runtime-fields label { justify-content: space-between; align-items: center; gap: 1rem; }
  .conflict-review { padding-top: 0.25rem; }
</style>
