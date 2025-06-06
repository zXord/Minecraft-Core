<script lang="ts">
  import { createEventDispatcher } from 'svelte';
  import { get } from 'svelte/store';
  import { slide } from 'svelte/transition';
  import { fetchModVersions } from '../../utils/mods/modAPI.js';
  import { minecraftVersion } from '../../stores/modStore.js';

  interface Mod {
    fileName: string;
    location: string;
    projectId?: string;
    versionId?: string;
    versionNumber?: string;
    name?: string;
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

{#if mods.length === 0}
  <div class="no-mods">No manual mods found.</div>
{:else}
  <div class="grid-header">
    <div class="header-cell">Mod Name</div>
    <div class="header-cell">Location</div>
    <div class="header-cell">Current Version</div>
    <div class="header-cell">Actions</div>
  </div>
  <div class="mods-grid">
    {#each mods as mod}
      <div class="mod-card {expanded === mod.fileName ? 'expanded' : ''} {mod.location === 'disabled' ? 'disabled' : ''}">
        <div class="mod-item-header-container">
          <div class="mod-info">
            <span class="mod-name">{mod.name || mod.fileName}</span>
          </div>
          <div class="mod-location">
            <span class="location-tag {mod.location === 'disabled' ? 'disabled' : 'enabled'}">
              {mod.location === 'disabled' ? 'Disabled' : 'Enabled'}
            </span>
          </div>
          <div class="mod-version">
            {#if mod.versionNumber}
              <span class="version-tag">v{mod.versionNumber}</span>
            {:else}
              <span class="version-tag unknown">Unknown</span>
            {/if}
          </div>
          <div class="mod-actions">
            {#if mod.projectId}
              <button class="action-btn version-btn" on:click={() => toggleVersions(mod)}>
                {expanded === mod.fileName ? 'Hide Versions' : 'Change Version'}
              </button>
            {/if}
            <button class="action-btn toggle-btn" on:click={() => handleToggle(mod)}>
              {mod.location === 'disabled' ? 'Enable' : 'Disable'}
            </button>
            <button class="action-btn delete-btn" on:click={() => handleDelete(mod)}>
              Delete
            </button>
          </div>
        </div>
        
        {#if expanded === mod.fileName}
          <div class="version-selector" transition:slide={{ duration: 200 }}>
            {#if versionsLoading[mod.projectId]}
              <div class="loading">Loading versions...</div>
            {:else}
              <div class="version-list">
                {#each versionsCache[mod.projectId] || [] as v}
                  <button
                    class="version-option {v.id === mod.versionId ? 'selected' : ''}"
                    on:click={() => selectVersion(mod, v.id)}
                  >
                    <span class="version-number">{v.versionNumber}</span>
                    {#if v.id === mod.versionId}
                      <span class="current-indicator">(installed)</span>
                    {/if}
                  </button>
                {/each}
              </div>
            {/if}
          </div>
        {/if}
      </div>
    {/each}
  </div>
{/if}

<style>
  .no-mods {
    text-align: center;
    padding: 2rem;
    color: rgba(255, 255, 255, 0.5);
    font-style: italic;
  }

  .grid-header {
    display: grid;
    grid-template-columns: 2fr 1fr 1fr 2fr;
    gap: 1rem;
    padding: 0.75rem 1rem;
    background: rgba(255, 255, 255, 0.05);
    border-radius: 6px 6px 0 0;
    font-weight: 600;
    color: rgba(255, 255, 255, 0.9);
    border-bottom: 1px solid rgba(255, 255, 255, 0.1);
  }

  .header-cell {
    display: flex;
    align-items: center;
  }

  .grid-header .header-cell:nth-child(2),
  .grid-header .header-cell:nth-child(3) {
    text-align: center;
    justify-content: center;
  }
  
  .grid-header .header-cell:nth-child(4) {
    text-align: right;
    justify-content: flex-end;
  }

  .mods-grid {
    display: flex;
    flex-direction: column;
    gap: 0.75rem;
  }

  .mod-card {
    background: rgba(255, 255, 255, 0.07);
    border-radius: 8px;
    overflow: hidden;
    box-shadow: 0 2px 4px rgba(0, 0, 0, 0.2);
    border: 1px solid rgba(255, 255, 255, 0.1);
    transition: all 0.2s ease;
  }

  .mod-card:hover {
    transform: translateY(-2px);
    box-shadow: 0 4px 8px rgba(0, 0, 0, 0.3);
    border-color: rgba(255, 255, 255, 0.2);
  }

  .mod-card.expanded {
    box-shadow: 0 2px 8px rgba(0, 0, 0, 0.2);
  }

  .mod-card.disabled {
    opacity: 0.6;
    background: rgba(139, 69, 19, 0.2);
  }

  .mod-item-header-container {
    display: grid;
    grid-template-columns: 2fr 1fr 1fr 2fr;
    gap: 1rem;
    padding: 1rem;
    align-items: center;
  }

  .mod-info {
    display: flex;
    flex-direction: column;
    gap: 0.25rem;
  }

  .mod-name {
    font-weight: 500;
    color: white;
    word-break: break-word;
  }

  .mod-location {
    display: flex;
    justify-content: center;
  }

  .location-tag {
    padding: 0.25rem 0.5rem;
    border-radius: 4px;
    font-size: 0.75rem;
    font-weight: 500;
    text-transform: uppercase;
  }

  .location-tag.enabled {
    background: rgba(34, 197, 94, 0.2);
    color: #22c55e;
    border: 1px solid rgba(34, 197, 94, 0.3);
  }

  .location-tag.disabled {
    background: rgba(239, 68, 68, 0.2);
    color: #ef4444;
    border: 1px solid rgba(239, 68, 68, 0.3);
  }

  .mod-version {
    display: flex;
    justify-content: center;
  }

  .version-tag {
    padding: 0.25rem 0.5rem;
    border-radius: 4px;
    font-size: 0.75rem;
    font-weight: 500;
    background: rgba(59, 130, 246, 0.2);
    color: #3b82f6;
    border: 1px solid rgba(59, 130, 246, 0.3);
  }

  .version-tag.unknown {
    background: rgba(156, 163, 175, 0.2);
    color: #9ca3af;
    border: 1px solid rgba(156, 163, 175, 0.3);
  }

  .mod-actions {
    display: flex;
    gap: 0.5rem;
    justify-content: flex-end;
    flex-wrap: wrap;
  }

  .action-btn {
    padding: 0.4rem 0.8rem;
    border: none;
    border-radius: 4px;
    font-size: 0.75rem;
    font-weight: 500;
    cursor: pointer;
    transition: all 0.2s ease;
    white-space: nowrap;
  }

  .version-btn {
    background: rgba(59, 130, 246, 0.2);
    color: #3b82f6;
    border: 1px solid rgba(59, 130, 246, 0.3);
  }

  .version-btn:hover {
    background: rgba(59, 130, 246, 0.3);
    border-color: rgba(59, 130, 246, 0.5);
  }

  .toggle-btn {
    background: rgba(168, 85, 247, 0.2);
    color: #a855f7;
    border: 1px solid rgba(168, 85, 247, 0.3);
  }

  .toggle-btn:hover {
    background: rgba(168, 85, 247, 0.3);
    border-color: rgba(168, 85, 247, 0.5);
  }

  .delete-btn {
    background: rgba(239, 68, 68, 0.2);
    color: #ef4444;
    border: 1px solid rgba(239, 68, 68, 0.3);
  }

  .delete-btn:hover {
    background: rgba(239, 68, 68, 0.3);
    border-color: rgba(239, 68, 68, 0.5);
  }

  .version-selector {
    padding: 1rem;
    background: rgba(0, 0, 0, 0.2);
    border-top: 1px solid rgba(255, 255, 255, 0.1);
  }

  .loading {
    text-align: center;
    color: rgba(255, 255, 255, 0.7);
    padding: 1rem;
    font-style: italic;
  }

  .version-list {
    display: flex;
    flex-direction: column;
    gap: 0.5rem;
    max-height: 200px;
    overflow-y: auto;
  }

  .version-option {
    display: flex;
    align-items: center;
    gap: 0.5rem;
    padding: 0.5rem 0.75rem;
    background: rgba(255, 255, 255, 0.05);
    border: 1px solid rgba(255, 255, 255, 0.1);
    border-radius: 4px;
    color: white;
    cursor: pointer;
    transition: all 0.2s ease;
  }

  .version-option:hover {
    background: rgba(255, 255, 255, 0.1);
    border-color: rgba(255, 255, 255, 0.2);
  }

  .version-option.selected {
    background: rgba(34, 197, 94, 0.2);
    border-color: rgba(34, 197, 94, 0.3);
    color: #22c55e;
    font-weight: 500;
  }

  .version-number {
    font-weight: 500;
  }

  .current-indicator {
    font-size: 0.75rem;
    color: rgba(255, 255, 255, 0.7);
    font-style: italic;
  }

  .version-option.selected .current-indicator {
    color: rgba(34, 197, 94, 0.8);
  }
</style>
