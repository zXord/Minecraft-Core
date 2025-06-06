<script lang="ts">
  import { createEventDispatcher } from 'svelte';
  import { get } from 'svelte/store';
  import { fetchModVersions } from '../../utils/mods/modAPI.js';
  import { minecraftVersion } from '../../stores/modStore.js';

  interface Mod {
    fileName: string;
    location: string;
    projectId?: string;
    versionId?: string;
    versionNumber?: string;
  }

  export let mods: Mod[] = [];

  const dispatch = createEventDispatcher();
  let expanded: string = '';
  let versionsCache: Record<string, any[]> = {};
  let versionsLoading: Record<string, boolean> = {};

  function toggleVersions(mod: Mod) {
    if (expanded === mod.fileName) {
      expanded = '';
      return;
    }
    expanded = mod.fileName;
    if (mod.projectId && !versionsCache[mod.projectId]) {
      loadVersions(mod.projectId);
    }
  }

  async function loadVersions(projectId: string) {
    versionsLoading[projectId] = true;
    try {
      const versions = await fetchModVersions(projectId, 'modrinth', false, true);
      versionsCache[projectId] = versions;
    } catch (err) {
      console.error('Failed to load versions', err);
      versionsCache[projectId] = [];
    } finally {
      versionsLoading[projectId] = false;
    }
  }

  function selectVersion(mod: Mod, versionId: string) {
    dispatch('install', { mod, versionId });
    expanded = '';
  }

  function handleToggle(mod: Mod) {
    const enabled = mod.location === 'disabled';
    dispatch('toggle', { fileName: mod.fileName, enabled });
  }

  function handleDelete(mod: Mod) {
    dispatch('delete', { fileName: mod.fileName });
  }
</script>

<div class="manual-mod-list">
  {#if mods.length === 0}
    <div class="empty-state">No manual mods found.</div>
  {:else}
    {#each mods as mod}
      <div class="mod-item">
        <div class="info">
          <span class="name">{mod.fileName}</span>
          {#if mod.versionNumber}
            <span class="version">v{mod.versionNumber}</span>
          {/if}
        </div>
        <div class="actions">
          {#if mod.projectId}
            <button class="version-btn" on:click={() => toggleVersions(mod)}>
              {expanded === mod.fileName ? 'Hide Versions' : 'Change Version'}
            </button>
          {/if}
          <button class="toggle-btn" on:click={() => handleToggle(mod)}>
            {mod.location === 'disabled' ? 'Enable' : 'Disable'}
          </button>
          <button class="delete-btn" on:click={() => handleDelete(mod)}>Delete</button>
        </div>
        {#if expanded === mod.fileName}
          <div class="version-list">
            {#if versionsLoading[mod.projectId]}
              <div class="loading">Loading versions...</div>
            {:else}
              {#each versionsCache[mod.projectId] || [] as v}
                <button
                  class:selected={v.id === mod.versionId}
                  on:click={() => selectVersion(mod, v.id)}
                >
                  {v.versionNumber}{v.id === mod.versionId ? ' (installed)' : ''}
                </button>
              {/each}
            {/if}
          </div>
        {/if}
      </div>
    {/each}
  {/if}
</div>

<style>
  .manual-mod-list { display: flex; flex-direction: column; gap: 0.75rem; }
  .mod-item { background:#374151; padding:0.75rem; border-radius:6px; }
  .info { color:white; display:flex; gap:0.5rem; }
  .actions { margin-top:0.5rem; display:flex; gap:0.5rem; }
  .version-list { margin-top:0.5rem; display:flex; flex-direction:column; gap:0.25rem; }
  button.selected { font-weight:bold; }
</style>
