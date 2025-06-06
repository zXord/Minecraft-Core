<script>
  import { createEventDispatcher } from 'svelte';
  export let visible = false;
  export let warnings = [];
  export let modsToUpdate = [];
  const dispatch = createEventDispatcher();

  function close() {
    dispatch('close');
  }
  function proceed() {
    dispatch('proceed');
  }
  function enableDeps() {
    dispatch('enable');
  }
  function installDeps() {
    dispatch('install');
  }
  function fixAll() {
    dispatch('fixAll');
  }
</script>

{#if visible}
  <div class="compatibility-warning-overlay" on:click={close}>
    <div class="compatibility-warning-dialog" on:click|stopPropagation>
      <h3>Compatibility Issues</h3>
      <div class="warnings-container">
        {#each warnings as w}
          <div class="warning-item {w.type}">
            <h4>{w.type}</h4>
            <span class="dependency-name">{w.dependency?.name}</span>
            <div class="required-by">Required by: {w.mods.join(', ')}</div>
          </div>
        {/each}
      </div>
      <div class="warning-actions">
        <button class="warning-cancel" on:click={close}>Cancel</button>
        {#if modsToUpdate.length > 0}
          <button class="warning-proceed" on:click={proceed}>Proceed Without Dependencies</button>
        {/if}
        <button class="warning-install" on:click={enableDeps}>Enable Dependencies</button>
        <button class="warning-install" on:click={installDeps}>Install Missing Dependencies</button>
        <button class="warning-install" on:click={fixAll}>Fix All Dependencies</button>
      </div>
    </div>
  </div>
{/if}

<style>
  /* styles reused from InstalledModList */
</style>
