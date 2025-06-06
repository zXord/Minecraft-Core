<script>
  import { createEventDispatcher } from 'svelte';
  import { slide } from 'svelte/transition';
  import { installedModInfo, modsWithUpdates, expandedInstalledMod, minecraftVersion, categorizedMods, serverState } from '../../../stores/modStore.js';
  import { toggleInstalledVersionSelector, updateInstalledMod, updateModToLatest } from '../../../utils/mods/installedModActions.js';

  export let mod;
  export let installedModVersionsCache = {};
  export let modStatus;
  export let selected = false;
  export let disabled = false;

  const dispatch = createEventDispatcher();

  $: modInfo = $installedModInfo.find(m => m.fileName === mod);
  $: updateInfo = $modsWithUpdates.get(mod);
  $: modCategoryInfo = $categorizedMods.find(m => m.fileName === mod);
  $: isExpanded = $expandedInstalledMod === mod;
</script>

<div class="mod-card {isExpanded ? 'expanded' : ''} {disabled ? 'disabled' : ''} {modCategoryInfo?.category || ''}">
  <div class="mod-item-header-container">
    <div class="select-cell">
      <input type="checkbox" bind:checked={selected} on:change={() => dispatch('toggleSelect', mod)} />
    </div>
    <div class="mod-info">
      <span class="mod-name">{modCategoryInfo?.name || mod}</span>
      {#if modInfo && modInfo.mcVersion}
        <span class="mc-version-tag">MC {modInfo.mcVersion}</span>
      {/if}
    </div>
    <div class="mod-location-column">
      {#if modCategoryInfo}
        {#if modCategoryInfo.category === 'server-only'}
          <span class="location-tag server-tag">Server</span>
        {:else if modCategoryInfo.category === 'client-only'}
          <span class="location-tag client-tag">Client</span>
        {:else}
          <span class="location-tag both-tag">Both</span>
        {/if}
      {/if}
    </div>
    <div class="mod-version-column">
      {#if modInfo && modInfo.versionNumber}
        <span class="version-tag current-version">{modInfo.versionNumber}</span>
      {/if}
    </div>
    <div class="mod-update-column">
      {#if updateInfo}
        <div class="update-container">
          <span class="version-tag new-version">{updateInfo.versionNumber}</span>
        </div>
      {:else}
        <span class="up-to-date">Up to date</span>
      {/if}
    </div>
    <div class="mod-actions">
      {#if updateInfo}
        <button class="update-button" on:click={() => updateModToLatest(mod, dispatch)} disabled={$serverState.status === 'Running'}>
          {#if $serverState.status === 'Running'}<span class="lock-icon">🔒</span>{/if} Update
        </button>
      {/if}
      <div class="button-row">
        <button class="version-toggle-button" on:click={() => toggleInstalledVersionSelector(mod, installedModVersionsCache, modStatus)} disabled={$serverState.status === 'Running'}>
          {#if $serverState.status === 'Running'}<span class="lock-icon">🔒</span>{/if}
          <span class="version-toggle-icon">{isExpanded ? '▲' : '▼'}</span>
        </button>
        {#if disabled}
          <button class="enable-button" on:click={() => dispatch('toggleDisable', { mod, disabled })} disabled={$serverState.status === 'Running'}>
            {#if $serverState.status === 'Running'}<span class="lock-icon">🔒</span>{/if} Enable
          </button>
        {:else}
          {#if updateInfo == null}
            <button class="delete-button" on:click={() => dispatch('delete', mod)} disabled={$serverState.status === 'Running'}>
              {#if $serverState.status === 'Running'}<span class="lock-icon">🔒</span>{/if} Delete
            </button>
          {/if}
          <button class="disable-button" on:click={() => dispatch('toggleDisable', { mod, disabled })} disabled={$serverState.status === 'Running'}>
            {#if $serverState.status === 'Running'}<span class="lock-icon">🔒</span>{/if} Disable
          </button>
        {/if}
      </div>
    </div>
  </div>

  {#if isExpanded && modInfo && modInfo.projectId}
    <div class="installed-mod-versions" transition:slide>
      {#if !installedModVersionsCache[modInfo.projectId]}
        <div class="loading-versions">Loading versions...</div>
      {:else if installedModVersionsCache[modInfo.projectId].length === 0}
        <div class="no-versions">No versions available</div>
      {:else}
        <div class="mod-versions" transition:slide>
          {#each installedModVersionsCache[modInfo.projectId] as version}
            {@const isCurrent = modInfo.versionId === version.id}
            {@const statusKey = `${modInfo.fileName}:${version.id}`}
            {@const status = modStatus.get(statusKey) || ''}
            <div class="mod-version-item {isCurrent ? 'current' : ''}">
              <div class="version-info">
                <span class="version-number">{version.versionNumber || version.name}</span>
                {#if version.gameVersions && version.gameVersions.includes($minecraftVersion)}
                  <span class="compatibility-badge compatible">✓ {$minecraftVersion}</span>
                {/if}
              </div>
              {#if isCurrent}
                <span class="version-status current">Installed</span>
              {:else}
                <div class="version-controls">
                  {#if status === 'updating'}
                    <span class="mod-status updating"></span>
                  {:else if status === 'success'}
                    <span class="mod-status success"></span>
                  {:else if status === 'error'}
                    <span class="mod-status error"></span>
                  {:else}
                    <button class="select-version" on:click={() => updateInstalledMod(modInfo.fileName, modInfo.projectId, version.id, installedModVersionsCache, modStatus, dispatch)}>
                      Select
                    </button>
                  {/if}
                </div>
              {/if}
            </div>
          {/each}
        </div>
      {/if}
    </div>
  {/if}
</div>

<style>
  /* styles reused from InstalledModList */
</style>
