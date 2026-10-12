<script>
  import { createEventDispatcher, onDestroy } from 'svelte';
  import { isPlanStaleError } from '../../utils/modpacks/modpackApi.js';
  import ConfirmationDialog from '../common/ConfirmationDialog.svelte';

  const dispatch = createEventDispatcher();
  export let reviewedPlan;
  export let reviewContext = null;
  export let startReviewedOperation = null;
  export let operationKind = '';
  export let targetLabel = '';
  export let busy = false;
  export let restorePointId = null;
  let showConfirmation = false;
  let error = null;
  let acceptEula = false;
  let startAfterInstall = false;
  let planStale = false;
  let activePlanId = null;
  let childAlive = true;
  let startOwner = null;
  let launchUnknown = false;
  onDestroy(() => { childAlive = false; startOwner = null; });

  $: if ((reviewedPlan?.planId || null) !== activePlanId) resetPlanState(reviewedPlan);
  $: plan = reviewedPlan?.planView || {};
  $: changes = plan.changes || {};
  $: blockers = plan.blockers || [];
  $: confirmation = plan.ownership?.confirmation || plan.confirmation || {};
  $: destructive = ['detach', 'uninstall', 'uninstall-managed'].includes(operationKind);
  $: sourceMutation = [
    'install-new', 'install-existing', 'update', 'downgrade', 'switch', 'repair',
    'files-only', 'import-files-only-new'
  ].includes(operationKind);
  $: hasReviewedPlan = Boolean(reviewedPlan?.planId && reviewedPlan?.planFingerprint);
  $: canRun = hasReviewedPlan && !planStale && !launchUnknown && blockers.length === 0 && (!sourceMutation || acceptEula);
  $: isDetach = operationKind === 'detach';
  $: isUninstall = ['uninstall', 'uninstall-managed'].includes(operationKind);
  $: isRollback = operationKind === 'rollback-restore-point';
  $: providerLabel = { github: 'GitHub Releases', modrinth: 'Modrinth', local: 'Local archive' }[plan.source?.provider] || '';

  function resetPlanState(nextPlan) {
    activePlanId = nextPlan?.planId || null;
    showConfirmation = false;
    error = null;
    planStale = false;
    acceptEula = false;
    startAfterInstall = false;
    startOwner = null;
    launchUnknown = false;
  }

  async function run() {
    if (!canRun || startOwner || launchUnknown || typeof startReviewedOperation !== 'function') return;
    const owner = { context: reviewContext, plan: reviewedPlan };
    startOwner = owner;
    busy = true;
    error = null;
    showConfirmation = false;
    try {
      const result = await startReviewedOperation({
        reviewContext: owner.context,
        planId: reviewedPlan.planId,
        planFingerprint: reviewedPlan.planFingerprint,
        choices: { acceptEula, startAfterInstall, restorePointId }
      });
      if (!childAlive || startOwner !== owner || reviewContext !== owner.context || reviewedPlan !== owner.plan) return;
      launchUnknown = result?.status === 'unknown';
      if (result?.status === 'not-invoked' && result.error) {
        if (isPlanStaleError(result.error)) planStale = true;
        else error = result.error;
      }
    } catch (caught) {
      if (childAlive && startOwner === owner && reviewContext === owner.context) launchUnknown = true;
    } finally {
      if (childAlive && startOwner === owner && reviewContext === owner.context) { busy = false; startOwner = null; }
    }
  }
</script>

<section class="modpack-surface mp-panel mp-stack" aria-label="Reviewed modpack operation plan">
  <div class="mp-toolbar"><div class="grow"><p class="mp-kicker">Reviewed lifecycle plan</p><h2 class="mp-title">{plan.title || operationKind.replaceAll('-', ' ')}</h2><p class="mp-subtitle">This one-use plan is bound to the exact server revision, selected artifacts, ownership evidence, and preflight checks.</p></div><button class="mp-button" type="button" on:click={() => dispatch('cancel')}>Change selection</button></div>

  <dl class="review-context" aria-label="Reviewed operation details">
    {#if targetLabel}<div><dt>Server</dt><dd>{targetLabel}</dd></div>{/if}
    {#if providerLabel || plan.source?.version}<div><dt>{isRollback || destructive ? 'Current release' : 'Selected release'}</dt><dd>{providerLabel}{providerLabel && plan.source?.version ? ' · ' : ''}{plan.source?.version || ''}</dd></div>{/if}
    {#if isRollback && plan.rollback?.id}<div><dt>Restore point</dt><dd>{plan.rollback.id}</dd></div>{/if}
    {#if isRollback}
      {#if plan.rollback?.sourceRevision != null}<div><dt>Snapshot revision</dt><dd>{plan.rollback.sourceRevision}</dd></div>{/if}
      <div><dt>World data</dt><dd>{plan.rollback?.worldIncluded === true ? 'Included in snapshot' : plan.rollback?.worldIncluded === false ? 'Not included in snapshot' : 'Unknown — not reported by restore point'}</dd></div>
    {/if}
    {#if plan.runtime}<div><dt>{isRollback ? 'Restored runtime' : 'Runtime'}</dt><dd>Minecraft {plan.runtime.minecraft} · {plan.runtime.loader} {plan.runtime.loaderVersion}{#if plan.runtime.java} · Java {plan.runtime.java}{/if}</dd></div>
    {:else if ['files-only', 'import-files-only-new'].includes(operationKind)}<div><dt>Runtime</dt><dd>Files only — no managed runtime</dd></div>{/if}
  </dl>

  {#if planStale}<div class="mp-state warning" tabindex="-1" aria-live="assertive"><strong>Reviewed plan needs a fresh preflight</strong><p>The server revision or one-use plan changed before the operation started. Nothing from this stale plan will run.</p><button class="mp-button" type="button" disabled={busy} on:click={() => dispatch('stale')}>Run a fresh preflight review</button></div>
  {:else if error}<div class="mp-state error" tabindex="-1" aria-live="assertive"><strong>Could not start the reviewed plan</strong><p>{error.message}</p></div>{/if}
  {#if launchUnknown}<div class="mp-state warning" role="status">Start outcome is unknown; it may already have started. Check owned operations before making another change.</div>{/if}

  {#if destructive}
    <div class="mp-split" aria-label="Detach and uninstall behavior comparison">
      <article class="mp-card behavior-card" class:selected={isDetach}><span class="mp-badge {isDetach ? 'good' : ''}">{isDetach ? 'Selected' : 'Alternative'}</span><h3>Detach and keep all files</h3><p>Modpack management and notifications stop. Exactly zero files are removed, and retained history remains available for audit.</p><ul><li>All pack and runtime files stay</li><li>Worlds and user additions stay</li><li>The instance becomes unmanaged</li></ul></article>
      <article class="mp-card behavior-card" class:selected={isUninstall}><span class="mp-badge {isUninstall ? 'warn' : ''}">{isUninstall ? 'Selected' : 'Alternative'}</span><h3>Remove managed pack files</h3><p>Remove exactly {confirmation.unchangedManagedRemovalCount || changes.removed || '0'} unchanged managed files while preserving worlds, user additions, protected configuration, and modified files.</p><ul><li>A verified restore point is created</li><li>Modified managed files remain flagged as orphans</li><li>It may leave a non-runnable files-only instance</li></ul></article>
    </div>
    <div class="mp-state warning"><strong>The server is not deleted</strong><p>Neither the instance nor its world is deleted. Uninstall removes only exact unchanged files owned by the managed pack/runtime after review.</p></div>
  {:else if isRollback}
    <div class="mp-state warning"><strong>Restore selected server snapshot</strong><p>Server files and any world data included in this restore point return to the saved snapshot. Changes made after that snapshot within the restored scope will be replaced or removed. Current backups and operation history are retained.</p><p>A per-file added/changed/removed comparison is not available for this review.</p></div>
    <div class="mp-state"><strong>Transaction protection</strong><p>A new safety restore point of the current server is created before changes. The complete sibling candidate is validated on loopback, and the original is restored if final-path health fails.</p></div>
  {:else}
    <div class="mp-grid" aria-label="Planned file diff">
      <div class="mp-card mp-metric"><span class="mp-muted">Added</span><strong>{changes.added || 0}</strong></div><div class="mp-card mp-metric"><span class="mp-muted">Changed</span><strong>{changes.changed || 0}</strong></div><div class="mp-card mp-metric"><span class="mp-muted">Removed</span><strong>{changes.removed || 0}</strong></div><div class="mp-card mp-metric"><span class="mp-muted">Preserved</span><strong>{changes.preserved || 0}</strong></div>
    </div>
    <div class="mp-state"><strong>Transaction protection</strong><p>A compatible restore point is created where required, the complete sibling candidate is validated on loopback, and the original is restored if final-path health fails.</p></div>
  {/if}

  {#if plan.warnings?.length}<div class="mp-state warning"><strong>Reviewed warnings</strong><ul>{#each plan.warnings as warning, index (index)}<li>{warning.message || warning.code || warning}</li>{/each}</ul></div>{/if}
  {#if blockers.length}<div class="mp-state error"><strong>Plan has unresolved blockers</strong><ul>{#each blockers as blocker, index (index)}<li>{blocker.message || blocker.code || blocker}</li>{/each}</ul></div>{/if}
  {#if sourceMutation}
    <label class="acknowledgement"><input type="checkbox" bind:checked={acceptEula} /><span><strong>I accept the Minecraft EULA</strong><br /><small>Pack-supplied EULA files are ignored; this explicit choice controls application-owned acceptance.</small></span></label>
    <label class="acknowledgement"><input type="checkbox" bind:checked={startAfterInstall} /><span>Start after install and validate final health</span></label>
  {/if}
  <div class="mp-actions"><button class="mp-button {isUninstall ? 'danger' : 'primary'}" type="button" disabled={busy || !canRun} on:click={() => destructive ? (showConfirmation = true) : run()}>{busy ? 'Starting…' : isDetach ? 'Detach and keep all files' : isUninstall ? 'Remove managed pack files' : 'Start reviewed operation'}</button></div>
</section>

<ConfirmationDialog visible={showConfirmation} title={isDetach ? 'Detach modpack management?' : 'Remove managed pack files?'} message={isDetach ? 'Management and notifications will stop; zero files are removed.' : 'Only the exact reviewed unchanged managed files will be removed. Worlds, user additions, and modified files stay.'} confirmText={isDetach ? 'Detach' : 'Remove managed files'} confirmType={isUninstall ? 'danger' : 'primary'} initialFocus="cancel" on:cancel={() => (showConfirmation = false)} on:confirm={run} />

<style>
  @import './modpack-ui.css';
  .behavior-card { display: grid; gap: 0.55rem; }
  .behavior-card.selected { border-color: rgba(255, 255, 255, 0.46); background: rgba(255, 255, 255, 0.09); box-shadow: inset 3px 0 rgba(255, 255, 255, 0.48); }
  .behavior-card h3, .behavior-card p { margin: 0; }
  .behavior-card p, .behavior-card li { color: var(--mp-muted); }
  .acknowledgement { display: flex; gap: 0.65rem; align-items: flex-start; }
  .acknowledgement input { margin-top: 0.25rem; }
  .review-context { display: grid; gap: 0.6rem; margin: 0; }
  .review-context > div { display: grid; grid-template-columns: 8rem minmax(0, 1fr); gap: 0.75rem; }
  .review-context dt { color: var(--mp-muted); }
  .review-context dd { margin: 0; overflow-wrap: anywhere; }
  @media (max-width: 520px) { .review-context > div { grid-template-columns: 1fr; gap: 0.2rem; } }
</style>
