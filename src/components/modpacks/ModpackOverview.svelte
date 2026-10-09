<script>
  import { createEventDispatcher } from 'svelte';
  const dispatch = createEventDispatcher();
  export let state = null;
  export let loading = false;
  export let status = 'unknown';
  export let loadError = null;
  export let actionsAvailable = false;

  function formatDate(value) {
    if (!value) return 'Not recorded';
    try { return new Date(value).toLocaleString(); } catch { return value; }
  }
</script>

<section class="modpack-surface mp-stack" aria-label="Modpack overview">
  {#if loading || status !== 'ready' || !state}
    <div class="mp-panel mp-state" class:error={status === 'error'} aria-live="polite"><strong>{status === 'error' ? 'Modpack state unavailable' : 'Loading managed modpack state…'}</strong>{#if loadError}<p>{loadError.message}</p>{/if}{#if state}<p>Previously loaded state is not current. Lifecycle actions are unavailable.</p>{/if}{#if status === 'error'}<button class="mp-button" type="button" on:click={() => dispatch('retry')}>Retry state</button>{/if}</div>
  {:else if state.modpackManaged === false && state.lifecycleMode === 'unmanaged'}
    <div class="mp-panel mp-stack"><div><p class="mp-kicker">Unmanaged server</p><h2 class="mp-title">No managed modpack is attached</h2><p class="mp-subtitle">Install a reviewed pack, import a safely classified files-only archive, or keep managing individual mods.</p></div><div class="mp-actions"><button class="mp-button primary" type="button" disabled={!actionsAvailable} on:click={() => dispatch('install')}>Install modpack</button><button class="mp-button" type="button" disabled={!actionsAvailable} on:click={() => dispatch('filesonly')}>Import files only</button></div></div>
  {:else}
    <div class="mp-panel mp-stack">
      <div class="mp-toolbar"><div class="grow"><p class="mp-kicker">{state.lifecycleMode === 'managed' ? 'Managed modpack' : 'Lifecycle state'}</p><h2 class="mp-title">{state.source?.title || 'Reviewed modpack'}</h2><p class="mp-subtitle">{state.source?.provider || 'local'} · version {state.source?.version || 'recorded'} · installed {formatDate(state.installedAt)}</p></div><span class="mp-badge {state.modpackManaged ? 'good' : 'warn'}">{state.lifecycleMode}</span></div>
      <div class="mp-grid">
        <div class="mp-card mp-metric"><span class="mp-muted">Minecraft</span><strong>{state.runtime?.minecraftVersion || '—'}</strong><span class="mp-muted">{state.runtime?.loaderFamily || 'loader'} {state.runtime?.loaderVersion || ''}</span></div>
        <div class="mp-card mp-metric"><span class="mp-muted">Java</span><strong>{state.runtime?.javaMajor ? `Java ${state.runtime.javaMajor}` : '—'}</strong><span class="mp-muted">{state.runtime?.os || 'Windows'} {state.runtime?.architecture || ''}</span></div>
        <div class="mp-card mp-metric"><span class="mp-muted">Managed files</span><strong>{state.managedFileCount || '0'}</strong><span class="mp-muted">User additions are tracked separately</span></div>
        <div class="mp-card mp-metric"><span class="mp-muted">Content revision</span><strong>{state.contentRevision ?? '—'}</strong><span class="mp-muted">Durable server state</span></div>
      </div>
      <div class="mp-state"><strong>Ownership remains explicit</strong><p>Pack-managed and runtime-managed files can be verified or repaired. Worlds, user additions, modified managed files, protected configuration, and secrets remain separately identified.</p></div>
    </div>
  {/if}
</section>

<style>@import './modpack-ui.css';</style>
