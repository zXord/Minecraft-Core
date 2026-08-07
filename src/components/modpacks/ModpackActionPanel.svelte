<script>
  import { createEventDispatcher } from 'svelte';
  const dispatch = createEventDispatcher();
  export let state = null;
  export let busy = false;
  export let verification = null;

  function verifyModpack() { dispatch('verify'); }
</script>

<section class="modpack-surface mp-panel mp-stack" aria-label="Modpack actions">
  <div><p class="mp-kicker">Integrity and ownership</p><h2 class="mp-title">Manage this installation</h2><p class="mp-subtitle">Verify is read-only. Repair is offered separately and only when managed content differs from the manifest.</p></div>
  <div class="mp-grid">
    <article class="mp-card action-card"><strong>Verify managed files</strong><p>Hash managed and runtime files without creating a restore point or changing the server.</p><button class="mp-button primary" type="button" disabled={busy} on:click={verifyModpack}>Verify</button></article>
    <article class="mp-card action-card"><strong>Repair detected mismatches</strong><p>Rebuild only missing or corrupt managed content, using a restore point and full health validation.</p><button class="mp-button" type="button" disabled={busy || !verification?.outcome?.result?.repairAvailable} on:click={() => dispatch('repair', { verification })}>Repair</button></article>
    <article class="mp-card action-card"><strong>Restore-point rollback</strong><p>Build a fresh candidate from an exact compatible restore point and validate it before commit.</p><button class="mp-button" type="button" disabled={busy} on:click={() => dispatch('rollback')}>Choose restore point</button></article>
  </div>
  <hr class="mp-divider" />
  <div class="mp-split">
    <article class="mp-card action-card"><strong>Detach</strong><p>Stop management and release notifications while keeping every server file.</p><button class="mp-button" type="button" disabled={busy} on:click={() => dispatch('detach')}>Review detach</button></article>
    <article class="mp-card action-card"><strong>Uninstall managed pack files</strong><p>Review exact unchanged managed removals while preserving worlds, user additions, and modified files.</p><button class="mp-button danger" type="button" disabled={busy} on:click={() => dispatch('uninstall')}>Review uninstall</button></article>
  </div>
</section>

<style>
  @import './modpack-ui.css';
  .action-card { display: flex; flex-direction: column; gap: 0.55rem; }
  .action-card p { flex: 1; margin: 0; color: var(--mp-muted); }
</style>
