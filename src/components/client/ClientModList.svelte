<script lang="ts">
  import { createEventDispatcher } from 'svelte';
  import { get } from 'svelte/store';
  import {
    installedModInfo,
    modsWithUpdates,
    expandedInstalledMod,
    minecraftVersion
  } from '../../stores/modStore.js';
  import { fetchModVersions } from '../../utils/mods/modAPI.js';

  // Types
  interface Mod {
    fileName: string;
    size?: number;
    lastModified?: string;
    location?: string;
  }

  interface ModSyncStatus {
    synchronized: boolean;
    missingMods?: string[];
    missingOptionalMods?: string[];
    totalRequired?: number;
    totalOptional?: number;
    totalPresent?: number;
    totalOptionalPresent?: number;
    presentEnabledMods?: string[];
    presentDisabledMods?: string[];
  }

  // Props
  export let mods: Mod[] = [];
  export let type: 'required' | 'optional' = 'required';
  export let modSyncStatus: ModSyncStatus | null = null;

  // Create event dispatcher
  const dispatch = createEventDispatcher();

  let versionsCache: Record<string, any[]> = {};
  let versionsLoading: Record<string, boolean> = {};

  // Get mod status from sync status
  function getModStatus(mod: Mod): string {
    if (!modSyncStatus) return 'unknown';
    
    // Check the appropriate missing mods list based on mod type
    const missingList = type === 'required' ? 
      (modSyncStatus.missingMods || []) : 
      (modSyncStatus.missingOptionalMods || []);
    
    const isMissing = missingList.includes(mod.fileName);
    
    if (isMissing) {
      return 'missing';
    }
    
    // For optional mods, also check if they're enabled or disabled
    if (type === 'optional' && modSyncStatus.presentDisabledMods && modSyncStatus.presentDisabledMods.includes(mod.fileName)) {
      return 'disabled';
    }
    
    return 'installed';
  }

  // Format file size
  function formatFileSize(bytes: number): string {
    if (!bytes) return 'Unknown size';
    
    const sizes = ['Bytes', 'KB', 'MB', 'GB'];
    if (bytes === 0) return '0 Bytes';
    
    const i = parseInt(Math.floor(Math.log(bytes) / Math.log(1024)).toString(), 10);
    return Math.round(bytes / Math.pow(1024, i) * 100) / 100 + ' ' + sizes[i];
  }

  // Handle mod toggle for optional mods
  function handleToggle(mod: Mod, enabled: boolean): void {
    if (type === 'required') return; // Required mods cannot be toggled

    dispatch('toggle', {
      fileName: mod.fileName,
      enabled: enabled
    });
  }

  // Handle mod deletion
  function handleDelete(mod: Mod): void {
    dispatch('delete', { fileName: mod.fileName });
  }

  // Handle download for missing mods
  function handleDownload(): void {
    dispatch('download');
  }

  async function toggleVersions(mod: Mod) {
    const isExpanded = $expandedInstalledMod === mod.fileName;
    if (isExpanded) {
      expandedInstalledMod.set(null);
      return;
    }

    expandedInstalledMod.set(mod.fileName);

    const info = get(installedModInfo).find(m => m.fileName === mod.fileName);
    if (info && info.projectId && !versionsCache[info.projectId]) {
      versionsLoading[info.projectId] = true;
      try {
        const versions = await fetchModVersions(info.projectId);
        versionsCache = { ...versionsCache, [info.projectId]: versions };
      } catch (err) {
        console.error('Failed to load versions', err);
        versionsCache = { ...versionsCache, [info.projectId]: [] };
      } finally {
        versionsLoading[info.projectId] = false;
      }
    }
  }

  function selectVersion(mod: Mod, versionId: string) {
    const info = get(installedModInfo).find(m => m.fileName === mod.fileName);
    if (info && info.projectId) {
      dispatch('updateMod', { modName: mod.fileName, projectId: info.projectId, versionId });
    }
    expandedInstalledMod.set(null);
  }
</script>

<div class="client-mod-list">
  {#if mods.length === 0}
    <div class="empty-state">
      <p>No {type} mods found.</p>
    </div>
  {:else}
    <div class="mod-list">
      {#each mods as mod}
        <div class="mod-item {type}">
          <div class="mod-info">
            <div class="mod-header">
              <span class="mod-name">{mod.fileName}</span>
              <div class="mod-status">
                {#if getModStatus(mod) === 'installed'}
                  <span class="status-badge installed">✅ Enabled</span>
                {:else if getModStatus(mod) === 'disabled'}
                  <span class="status-badge disabled">⏸️ Disabled</span>
                {:else if getModStatus(mod) === 'missing'}
                  <span class="status-badge missing">❌ Missing</span>
                {:else}
                  <span class="status-badge unknown">❓ Unknown</span>
                {/if}
              </div>
            </div>
            
            <div class="mod-details">
              {#if mod.size}
                <span class="mod-size">{formatFileSize(mod.size)}</span>
              {/if}
              {#if mod.lastModified}
                <span class="mod-date">Modified: {new Date(mod.lastModified).toLocaleDateString()}</span>
              {/if}
              {#if mod.location}
                <span class="mod-location">Location: {mod.location}</span>
              {/if}
            </div>
          </div>

          <div class="mod-actions">
            {#if $modsWithUpdates.has(mod.fileName)}
              {@const updateInfo = $modsWithUpdates.get(mod.fileName)}
              <button
                class="update-button"
                on:click={() => selectVersion(mod, updateInfo.id)}
              >
                Update
              </button>
            {/if}

            <button
              class="version-toggle-button"
              on:click={() => toggleVersions(mod)}
              aria-expanded={$expandedInstalledMod === mod.fileName}
            >
              <span class="version-toggle-icon">{$expandedInstalledMod === mod.fileName ? '▲' : '▼'}</span>
            </button>

            {#if type === 'required'}
              <span class="required-label">Required</span>
              {#if getModStatus(mod) === 'missing'}
                <button class="download-button" on:click={handleDownload}>
                  📥 Download
                </button>
              {/if}
            {:else if type === 'optional'}
              <div class="toggle-control">
                <label class="toggle-label">
                  <input
                    type="checkbox"
                    checked={getModStatus(mod) === 'installed'}
                    on:change={(e) => handleToggle(mod, (e.target as HTMLInputElement).checked)}
                    class="toggle-input"
                    disabled={getModStatus(mod) === 'missing'}
                  />
                  <span class="toggle-slider"></span>
                  <span class="toggle-text">
                    {#if getModStatus(mod) === 'missing'}
                      Missing
                    {:else if getModStatus(mod) === 'installed'}
                      Enabled
                    {:else}
                      Disabled
                    {/if}
                  </span>
                </label>
              </div>
              <button class="delete-button" on:click={() => handleDelete(mod)}>
                🗑️ Delete
              </button>
            {/if}
          </div>

          {#if $expandedInstalledMod === mod.fileName}
            {@const info = get(installedModInfo).find(m => m.fileName === mod.fileName)}
            {#if info && info.projectId}
              <div class="version-list">
                {#if versionsLoading[info.projectId]}
                  <div class="loading-versions">Loading versions...</div>
                {:else}
                  {#each versionsCache[info.projectId] || [] as v}
                    <div class="version-item">
                      <span class="version-number">{v.versionNumber || v.name}</span>
                      <button class="select-version" on:click={() => selectVersion(mod, v.id)}>
                        Select
                      </button>
                    </div>
                  {/each}
                {/if}
              </div>
            {/if}
          {/if}
        </div>
      {/each}
    </div>

    <!-- Summary for missing mods -->
    {#if modSyncStatus && modSyncStatus.missingMods && modSyncStatus.missingMods.length > 0}
      <div class="summary">
        <div class="missing-summary">
          <span class="summary-text">
            {modSyncStatus.missingMods.length} mod(s) need to be downloaded
          </span>
          <button class="download-all-button" on:click={handleDownload}>
            📥 Download All Missing
          </button>
        </div>
      </div>
    {/if}
  {/if}
</div>

<style>
  .client-mod-list {
    width: 100%;
  }

  .empty-state {
    text-align: center;
    padding: 2rem;
    color: #9ca3af;
    font-style: italic;
  }

  .mod-list {
    display: flex;
    flex-direction: column;
    gap: 0.75rem;
  }

  .mod-item {
    background-color: #374151;
    border-radius: 6px;
    border: 1px solid #4b5563;
    padding: 1rem;
    display: flex;
    justify-content: space-between;
    align-items: center;
    transition: border-color 0.2s;
  }

  .mod-item.required {
    border-left: 4px solid #ef4444;
  }

  .mod-item.optional {
    border-left: 4px solid #3b82f6;
  }

  .mod-item:hover {
    border-color: #6b7280;
  }

  .mod-info {
    flex: 1;
    display: flex;
    flex-direction: column;
    gap: 0.5rem;
  }

  .mod-header {
    display: flex;
    justify-content: space-between;
    align-items: center;
  }

  .mod-name {
    color: white;
    font-weight: 600;
    font-size: 1rem;
  }

  .mod-status {
    display: flex;
    align-items: center;
  }

  .status-badge {
    padding: 0.25rem 0.5rem;
    border-radius: 4px;
    font-size: 0.8rem;
    font-weight: 500;
  }

  .status-badge.installed {
    background-color: rgba(16, 185, 129, 0.2);
    color: #10b981;
  }

  .status-badge.disabled {
    background-color: rgba(245, 158, 11, 0.2);
    color: #f59e0b;
  }

  .status-badge.missing {
    background-color: rgba(239, 68, 68, 0.2);
    color: #ef4444;
  }

  .status-badge.unknown {
    background-color: rgba(107, 114, 128, 0.2);
    color: #9ca3af;
  }

  .mod-details {
    display: flex;
    gap: 1rem;
    font-size: 0.8rem;
    color: #9ca3af;
  }

  .mod-actions {
    display: flex;
    align-items: center;
    gap: 1rem;
    margin-left: 1rem;
  }

  .required-label {
    color: #ef4444;
    font-weight: 500;
    font-size: 0.9rem;
  }

  .download-button, .download-all-button {
    background-color: #3b82f6;
    color: white;
    border: none;
    border-radius: 4px;
    padding: 0.5rem 0.75rem;
    font-size: 0.8rem;
    cursor: pointer;
    transition: background-color 0.2s;
  }

  .download-button:hover, .download-all-button:hover {
    background-color: #2563eb;
  }

  .toggle-control {
    display: flex;
    align-items: center;
  }

  .toggle-label {
    display: flex;
    align-items: center;
    gap: 0.5rem;
    cursor: pointer;
    user-select: none;
  }

  .toggle-input {
    display: none;
  }

  .toggle-slider {
    position: relative;
    width: 44px;
    height: 24px;
    background-color: #4b5563;
    border-radius: 12px;
    transition: background-color 0.2s;
  }

  .toggle-slider::before {
    content: '';
    position: absolute;
    width: 20px;
    height: 20px;
    border-radius: 10px;
    background-color: white;
    top: 2px;
    left: 2px;
    transition: transform 0.2s;
  }

  .toggle-input:checked + .toggle-slider {
    background-color: #3b82f6;
  }

  .toggle-input:checked + .toggle-slider::before {
    transform: translateX(20px);
  }

  .toggle-text {
    color: #e5e7eb;
    font-size: 0.9rem;
    font-weight: 500;
  }

  .delete-button {
    background-color: rgba(244, 67, 54, 0.2);
    color: #ff6b6b;
    border: none;
    border-radius: 4px;
    padding: 0.5rem 0.75rem;
    font-size: 0.8rem;
    cursor: pointer;
    transition: background-color 0.2s;
  }

  .delete-button:hover {
    background-color: rgba(244, 67, 54, 0.3);
  }

  .summary {
    margin-top: 1rem;
    padding: 1rem;
    background-color: #374151;
    border-radius: 6px;
    border: 1px solid #4b5563;
  }

  .missing-summary {
    display: flex;
    justify-content: space-between;
    align-items: center;
  }

  .summary-text {
    color: #f59e0b;
    font-weight: 500;
  }

  .update-button {
    background: #1bd96a;
    color: #000;
    font-weight: 600;
    padding: 0.35rem 0.75rem;
    border-radius: 6px;
    border: none;
    cursor: pointer;
    transition: background-color 0.2s;
  }

  .update-button:hover {
    background: #0ec258;
  }

  .version-toggle-button {
    background: rgba(255, 255, 255, 0.1);
    border: none;
    border-radius: 4px;
    width: 2rem;
    height: 2rem;
    display: flex;
    align-items: center;
    justify-content: center;
    cursor: pointer;
    transition: background 0.2s;
  }

  .version-toggle-button:hover {
    background: rgba(255, 255, 255, 0.2);
  }

  .version-toggle-icon {
    font-size: 0.7rem;
    color: rgba(255, 255, 255, 0.7);
  }

  .version-list {
    margin-top: 0.5rem;
    display: flex;
    flex-direction: column;
    gap: 0.25rem;
  }

  .version-item {
    display: flex;
    justify-content: space-between;
    align-items: center;
    padding: 0.5rem;
    background: rgba(255, 255, 255, 0.05);
    border-radius: 4px;
  }

  .select-version {
    background: #646cff;
    color: white;
    border: none;
    padding: 0.25rem 0.5rem;
    border-radius: 4px;
    cursor: pointer;
  }

  .select-version:hover {
    background: #7a81ff;
  }
</style> 