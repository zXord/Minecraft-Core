<script>
  import { createEventDispatcher } from 'svelte';
  const dispatch = createEventDispatcher();
  export let state = null;
  export let busy = false;

  $: managed = state?.modpackManaged === true;
  $: lifecycleMode = state?.lifecycleMode || (managed ? 'managed' : 'unmanaged');
  $: inactive = !managed && ['detached', 'files-only', 'uninstalled'].includes(lifecycleMode);

  function verifyModpack() { dispatch('verify'); }
</script>

<section class="modpack-surface mp-panel mp-stack" aria-label="Modpack actions">
  {#if managed}
    <div><p class="mp-kicker">Integrity and ownership</p><h2 class="mp-title">Manage this installation</h2><p class="mp-subtitle">Verify is read-only. Review repair checks the exact installed source and current files before any change.</p></div>
    <div class="mp-grid">
      <article class="mp-card action-card"><strong>Verify managed files</strong><p>Hash managed and runtime files without creating a restore point or changing the server.</p><button class="mp-button primary" type="button" disabled={busy} on:click={verifyModpack}>Verify</button></article>
      <article class="mp-card action-card"><strong>Review repair</strong><p>Review the exact installed source and check current files again. Changes require fresh preflight review and an explicit Start, with a restore point and full health validation.</p><button class="mp-button" type="button" disabled={busy} on:click={() => dispatch('repair')}>Review repair</button></article>
      <article class="mp-card action-card"><strong>Restore-point rollback</strong><p>Build a fresh candidate from an exact compatible restore point and validate it before commit.</p><button class="mp-button" type="button" disabled={busy} on:click={() => dispatch('rollback')}>Choose restore point</button></article>
    </div>
    <hr class="mp-divider" />
    <div class="mp-split">
      <article class="mp-card action-card"><strong>Detach</strong><p>Stop management and release notifications while keeping every server file.</p><button class="mp-button" type="button" disabled={busy} on:click={() => dispatch('detach')}>Review detach</button></article>
      <article class="mp-card action-card"><strong>Uninstall managed pack files</strong><p>Review exact unchanged managed removals while preserving worlds, user additions, and modified files.</p><button class="mp-button danger" type="button" disabled={busy} on:click={() => dispatch('uninstall')}>Review uninstall</button></article>
    </div>
  {:else if inactive}
    <div>
      <p class="mp-kicker">Lifecycle history retained</p>
      <h2 class="mp-title">{lifecycleMode === 'detached' ? 'Management is detached' : 'Managed files are inactive'}</h2>
      <p class="mp-subtitle">Verify, repair, detach, and uninstall require an active managed manifest. You can still review an exact compatible restore point; Minecraft Core validates it before making any change.</p>
    </div>
    <article class="mp-card action-card"><strong>Restore-point rollback</strong><p>Rebuild a managed candidate from a compatible retained restore point and validate it before commit.</p><button class="mp-button primary" type="button" disabled={busy} on:click={() => dispatch('rollback')}>Choose restore point</button></article>
  {:else}
    <div>
      <p class="mp-kicker">No lifecycle ownership</p>
      <h2 class="mp-title">No managed modpack is attached</h2>
      <p class="mp-subtitle">There is no managed manifest to verify, repair, detach, uninstall, or roll back. Use Overview to install a reviewed modpack or import files without management.</p>
    </div>
  {/if}
</section>

<style>
  @import './modpack-ui.css';
  .action-card { display: flex; flex-direction: column; gap: 0.55rem; }
  .action-card p { flex: 1; margin: 0; color: var(--mp-muted); }
</style>
