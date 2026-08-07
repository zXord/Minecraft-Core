<script>
  import { createEventDispatcher } from 'svelte';
  import { modpackApi } from '../../utils/modpacks/modpackApi.js';
  import ConfirmationDialog from '../common/ConfirmationDialog.svelte';

  const dispatch = createEventDispatcher();
  export let reviewedPlan;
  export let operationKind = '';
  export let busy = false;
  export let restorePointId = null;
  let showConfirmation = false;
  let error = null;
  let acceptEula = true;
  let startAfterInstall = false;

  $: plan = reviewedPlan?.planView || {};
  $: changes = plan.changes || {};
  $: blockers = plan.blockers || [];
  $: confirmation = plan.ownership?.confirmation || plan.confirmation || {};
  $: destructive = ['detach', 'uninstall', 'uninstall-managed'].includes(operationKind);
  $: isDetach = operationKind === 'detach';
  $: isUninstall = ['uninstall', 'uninstall-managed'].includes(operationKind);

  async function run() {
    if (blockers.length > 0) return;
    busy = true;
    error = null;
    showConfirmation = false;
    try {
      const job = await modpackApi.startOperation({
        planId: reviewedPlan.planId,
        planFingerprint: reviewedPlan.planFingerprint,
        choices: { acceptEula, startAfterInstall, restorePointId }
      });
      dispatch('started', { job });
    } catch (caught) {
      error = caught;
    } finally {
      busy = false;
    }
  }
</script>

<section class="modpack-surface mp-panel mp-stack" aria-label="Reviewed modpack operation plan">
  <div class="mp-toolbar"><div class="grow"><p class="mp-kicker">Reviewed lifecycle plan</p><h2 class="mp-title">{plan.title || operationKind.replaceAll('-', ' ')}</h2><p class="mp-subtitle">This one-use plan is bound to the exact server revision, selected artifacts, ownership evidence, and preflight checks.</p></div><button class="mp-button" type="button" on:click={() => dispatch('cancel')}>Change selection</button></div>

  {#if error}<div class="mp-state error" tabindex="-1" aria-live="assertive"><strong>Could not start the reviewed plan</strong><p>{error.message}</p></div>{/if}

  {#if destructive}
    <div class="mp-split" aria-label="Detach and uninstall behavior comparison">
      <article class="mp-card behavior-card" class:selected={isDetach}><span class="mp-badge {isDetach ? 'good' : ''}">{isDetach ? 'Selected' : 'Alternative'}</span><h3>Detach and keep all files</h3><p>Modpack management and notifications stop. Exactly zero files are removed, and retained history remains available for audit.</p><ul><li>All pack and runtime files stay</li><li>Worlds and user additions stay</li><li>The instance becomes unmanaged</li></ul></article>
      <article class="mp-card behavior-card" class:selected={isUninstall}><span class="mp-badge {isUninstall ? 'warn' : ''}">{isUninstall ? 'Selected' : 'Alternative'}</span><h3>Remove managed pack files</h3><p>Remove exactly {confirmation.unchangedManagedRemovalCount || changes.removed || '0'} unchanged managed files while preserving worlds, user additions, protected configuration, and modified files.</p><ul><li>A verified restore point is created</li><li>Modified managed files remain flagged as orphans</li><li>It may leave a non-runnable files-only instance</li></ul></article>
    </div>
    <div class="mp-state warning"><strong>The server is not deleted</strong><p>Neither the instance nor its world is deleted. Uninstall removes only exact unchanged files owned by the managed pack/runtime after review.</p></div>
  {:else}
    <div class="mp-grid" aria-label="Planned file diff">
      <div class="mp-card mp-metric"><span class="mp-muted">Added</span><strong>{changes.added || 0}</strong></div><div class="mp-card mp-metric"><span class="mp-muted">Changed</span><strong>{changes.changed || 0}</strong></div><div class="mp-card mp-metric"><span class="mp-muted">Removed</span><strong>{changes.removed || 0}</strong></div><div class="mp-card mp-metric"><span class="mp-muted">Preserved</span><strong>{changes.preserved || 0}</strong></div>
    </div>
    <div class="mp-state"><strong>Transaction protection</strong><p>A compatible restore point is created where required, the complete sibling candidate is validated on loopback, and the original is restored if final-path health fails.</p></div>
  {/if}

  {#if plan.warnings?.length}<div class="mp-state warning"><strong>Reviewed warnings</strong><ul>{#each plan.warnings as warning, index (index)}<li>{warning.message || warning.code || warning}</li>{/each}</ul></div>{/if}
  {#if blockers.length}<div class="mp-state error"><strong>Plan has unresolved blockers</strong><ul>{#each blockers as blocker, index (index)}<li>{blocker.message || blocker.code || blocker}</li>{/each}</ul></div>{/if}
  <div class="mp-actions"><button class="mp-button {isUninstall ? 'danger' : 'primary'}" type="button" disabled={busy || blockers.length > 0} on:click={() => destructive ? (showConfirmation = true) : run()}>{busy ? 'Starting…' : isDetach ? 'Detach and keep all files' : isUninstall ? 'Remove managed pack files' : 'Start reviewed operation'}</button></div>
</section>

<ConfirmationDialog visible={showConfirmation} title={isDetach ? 'Detach modpack management?' : 'Remove managed pack files?'} message={isDetach ? 'Management and notifications will stop; zero files are removed.' : 'Only the exact reviewed unchanged managed files will be removed. Worlds, user additions, and modified files stay.'} confirmText={isDetach ? 'Detach' : 'Remove managed files'} confirmType={isUninstall ? 'danger' : 'primary'} initialFocus="cancel" on:cancel={() => (showConfirmation = false)} on:confirm={run} />

<style>
  @import './modpack-ui.css';
  .behavior-card { display: grid; gap: 0.55rem; }
  .behavior-card.selected { border-color: rgba(124, 131, 255, 0.75); }
  .behavior-card h3, .behavior-card p { margin: 0; }
  .behavior-card p, .behavior-card li { color: var(--mp-muted); }
</style>
