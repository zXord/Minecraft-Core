<script lang="ts">
  import { onMount } from 'svelte';
  import { slide } from 'svelte/transition';
  import { get } from 'svelte/store'; // Import get
  import ConfirmationDialog from '../common/ConfirmationDialog.svelte';
  import { serverManagedFiles, minecraftVersion } from '../../stores/modStore';

  interface DetailedMod {
    fileName: string;
    name?: string;
    version?: string;
    authors?: string[];
    description?: string;
    projectId?: string;
    loaderType?: string;
    gameVersions?: string[];
    size: number;
    lastModified: Date;
    enabled: boolean;
    hasUpdate?: boolean;
    latestVersion?: string;
    updateUrl?: string;
  }
  export let clientPath: string = '';
  
  let mods: DetailedMod[] = [];
  let loading = true;
  let error = '';
  let expanded: string = '';
  let checkingUpdates = false;
  let updatingMods: Set<string> = new Set();
  let showRemoveDialog = false;
  let modToRemove: DetailedMod | null = null;
  onMount(async () => {
    await loadManualMods();
  });

  // React to clientPath changes
  $: if (clientPath) {
    loadManualMods();
  }
  async function loadManualMods() {
    if (!clientPath) {
      return;
    }
    
    loading = true;
    error = '';
    
    try {
      // Pass the set of server managed files to the IPC handler
      const managedFilesSet = get(serverManagedFiles);
      const result = await window.electron.invoke('get-manual-mods-detailed', { 
        clientPath,
        serverManagedFiles: Array.from(managedFilesSet) // Convert Set to Array for IPC
      });
      
      if (result.success) {
        mods = result.mods;
      } else {
        error = result.error || 'Failed to load manual mods';
      }
    } catch (err) {
      error = err.message || 'Failed to load manual mods';
    } finally {
      loading = false;
    }
  }

  async function checkForUpdates() {
    if (!clientPath || checkingUpdates) return;
    
    checkingUpdates = true;
    try {
      const currentMinecraftVersion = get(minecraftVersion);
      const managedFiles = get(serverManagedFiles); // Get the server managed files from the store

      if (!currentMinecraftVersion) {
        checkingUpdates = false;
        return;
      }

      const result = await window.electron.invoke('check-manual-mod-updates', { 
        clientPath, 
        minecraftVersion: currentMinecraftVersion,
        serverManagedFiles: Array.from(managedFiles) // Pass the server managed files
      });
      if (result.success) {
        // Update mods with update information
        mods = mods.map(mod => {
          const updateInfo = result.updates.find(u => u.fileName === mod.fileName);
          if (updateInfo) {
            return {
              ...mod,
              hasUpdate: updateInfo.hasUpdate,
              latestVersion: updateInfo.latestVersion,
              updateUrl: updateInfo.updateUrl
            };
          }
          return mod;
        });
      }
    } catch (err) {
    } finally {
      checkingUpdates = false;
    }
  }
  async function toggleMod(mod: DetailedMod) {
    // Optimistic UI update - update the mod state immediately
    const originalEnabled = mod.enabled;
    mod.enabled = !mod.enabled;
    mods = mods; // Trigger reactivity
    
    try {
      const result = await window.electron.invoke('toggle-manual-mod', {
        clientPath,
        fileName: mod.fileName,
        enable: mod.enabled
      });
      
      if (!result.success) {
        // Revert the optimistic update if the operation failed
        mod.enabled = originalEnabled;
        mods = mods; // Trigger reactivity
        error = result.error || 'Failed to toggle mod';
      }
    } catch (err) {
      // Revert the optimistic update if an error occurred
      mod.enabled = originalEnabled;
      mods = mods; // Trigger reactivity
      error = err.message || 'Failed to toggle mod';
    }
  }
  async function updateMod(mod: DetailedMod) {
    if (!mod.hasUpdate || updatingMods.has(mod.fileName)) return;
    
    updatingMods.add(mod.fileName);
    updatingMods = updatingMods; // Trigger reactivity
    
    try {
      const result = await window.electron.invoke('update-manual-mod', {
        clientPath,
        fileName: mod.fileName,
        newVersion: mod.latestVersion,
        downloadUrl: mod.updateUrl
      });
      
      if (result.success) {
        // Update the mod in place instead of reloading everything
        const modIndex = mods.findIndex(m => m.fileName === mod.fileName);
        if (modIndex !== -1) {
          // Update the mod properties with new version info
          mods[modIndex] = {
            ...mods[modIndex],
            version: mod.latestVersion,
            hasUpdate: false,
            latestVersion: undefined,
            updateUrl: undefined
          };
          mods = mods; // Trigger reactivity
        }
      } else {
        error = result.error || 'Failed to update mod';
      }
    } catch (err) {
      error = err.message || 'Failed to update mod';
    } finally {
      updatingMods.delete(mod.fileName);
      updatingMods = updatingMods; // Trigger reactivity
    }
  }

  function promptRemove(mod: DetailedMod) {
    modToRemove = mod;
    showRemoveDialog = true;
  }
  async function confirmRemove() {
    if (!modToRemove) return;

    const mod = modToRemove;
    showRemoveDialog = false;
    
    // Optimistically remove the mod from the UI
    const modIndex = mods.findIndex(m => m.fileName === mod.fileName);
    const originalMods = [...mods];
    
    if (modIndex !== -1) {
      mods = mods.filter(m => m.fileName !== mod.fileName);
    }
    
    modToRemove = null;

    try {
      const result = await window.electron.invoke('remove-manual-mods', {
        clientPath,
        fileNames: [mod.fileName]
      });

      if (!result.success) {
        // Restore the mod if removal failed
        mods = originalMods;
        error = result.error || 'Failed to remove mod';
      }
    } catch (err) {
      // Restore the mod if an error occurred
      mods = originalMods;
      error = err.message || 'Failed to remove mod';
    }
  }

  function toggleExpanded(fileName: string) {
    expanded = expanded === fileName ? '' : fileName;
  }
  function formatFileSize(bytes: number): string {
    if (bytes === null || bytes === undefined || isNaN(bytes)) return 'Unknown size';
    if (bytes === 0) return '0 B';
    const k = 1024;
    const sizes = ['B', 'KB', 'MB', 'GB'];
    const i = Math.floor(Math.log(bytes) / Math.log(k));
    return parseFloat((bytes / Math.pow(k, i)).toFixed(1)) + ' ' + sizes[i];
  }

  function formatDate(date: Date): string {
    return new Intl.DateTimeFormat('en-US', {
      year: 'numeric',
      month: 'short',
      day: 'numeric',
      hour: '2-digit',
      minute: '2-digit'
    }).format(date);
  }
</script>

{#if loading}
  <div class="loading-container">
    <p>Loading client-side mods...</p>
    <!-- You can add a spinner or a more elaborate loading animation here -->
  </div>
{:else if error}
  <div class="error-container">
    <p class="error-message">Error loading mods: {error}</p>
    <button on:click={loadManualMods} class="retry-button">Retry</button>
  </div>
{:else}
  <div class="manual-mods-container">
    <!-- Removed "Manual Mods ({mods.length})" header -->
    <div class="actions-header">
      <button 
        class="action-btn check-updates-btn" 
        on:click={checkForUpdates}
        disabled={checkingUpdates}
      >
        {checkingUpdates ? 'Checking...' : 'Check for Updates'}
      </button>
      <button class="action-btn refresh-btn" on:click={loadManualMods}>
        Refresh
      </button>
    </div>

    <div class="grid-header">
      <div class="header-cell">Mod Details</div>
      <div class="header-cell">Status</div>
      <div class="header-cell">Version</div>
      <div class="header-cell">Actions</div>
    </div>    <div class="mods-grid">
      {#each mods as mod (mod.fileName)}        <div class="mod-card {expanded === mod.fileName ? 'expanded' : ''} {!mod.enabled ? 'disabled' : ''}">
          <div class="mod-header" 
               role="button" 
               tabindex="0"
               on:click={() => toggleExpanded(mod.fileName)}
               on:keydown={(e) => { if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); toggleExpanded(mod.fileName); } }}>
            <div class="mod-info">
              <div class="mod-name">{mod.name || mod.fileName}</div>
              {#if mod.authors && mod.authors.length > 0}
                <div class="mod-authors">by {mod.authors.join(', ')}</div>
              {/if}
              <div class="mod-file-info">
                <span class="file-size">{formatFileSize(mod.size)}</span>
                <span class="file-date">Modified: {formatDate(mod.lastModified)}</span>
              </div>
            </div>
            
            <div class="mod-status">
              <span class="status-tag {mod.enabled ? 'enabled' : 'disabled'}">
                {mod.enabled ? 'Enabled' : 'Disabled'}
              </span>
              {#if mod.hasUpdate}
                <span class="update-badge">Update Available</span>
              {/if}
            </div>
            
            <div class="mod-version">
              {#if mod.version}
                <span class="version-tag">v{mod.version}</span>
              {:else}
                <span class="version-tag unknown">Unknown</span>
              {/if}            </div>
            
            <div class="mod-actions">              {#if mod.hasUpdate}
                <button 
                  class="action-btn update-btn"
                  on:click|stopPropagation={() => updateMod(mod)}
                  disabled={updatingMods.has(mod.fileName)}
                  title="Update to v{mod.latestVersion}"
                >
                  {updatingMods.has(mod.fileName) ? 'Updating...' : `Update to v${mod.latestVersion}`}
                </button>
              {/if}
              <button 
                class="action-btn toggle-btn" 
                on:click|stopPropagation={() => toggleMod(mod)}
                title={mod.enabled ? 'Disable mod' : 'Enable mod'}
              >
                {mod.enabled ? 'Disable' : 'Enable'}
              </button>
              <button
                class="action-btn delete-btn"
                on:click|stopPropagation={() => promptRemove(mod)}
                title="Remove mod"
              >
                Remove
              </button>
            </div>
          </div>
          
          {#if expanded === mod.fileName}
            <div class="mod-details" transition:slide={{ duration: 200 }}>              <div class="details-grid">
                <div class="detail-item">
                  <div class="detail-label">File Name:</div>
                  <span>{mod.fileName}</span>
                </div>
                {#if mod.description}
                  <div class="detail-item description">
                    <div class="detail-label">Description:</div>
                    <span>{mod.description}</span>
                  </div>
                {/if}
                {#if mod.projectId}
                  <div class="detail-item">
                    <div class="detail-label">Project ID:</div>
                    <span>{mod.projectId}</span>
                  </div>
                {/if}
                {#if mod.loaderType}
                  <div class="detail-item">
                    <div class="detail-label">Mod Loader:</div>
                    <span class="loader-tag">{mod.loaderType}</span>
                  </div>
                {/if}
                {#if mod.gameVersions && mod.gameVersions.length > 0}                  <div class="detail-item">
                    <div class="detail-label">Game Versions:</div>
                    <div class="game-versions">
                      {#each mod.gameVersions as version (version)}
                        <span class="version-chip">{version}</span>
                      {/each}
                    </div>
                  </div>
                {/if}
              </div>
            </div>
          {/if}
        </div>
      {/each}
    </div>
  </div>
{/if}

<ConfirmationDialog
  bind:visible={showRemoveDialog}
  title="Remove Mod"
  message={`Are you sure you want to remove ${modToRemove?.name || modToRemove?.fileName}?`}
  on:confirm={confirmRemove}
  on:cancel={() => { showRemoveDialog = false; modToRemove = null; }}
/>

<style>  .loading-container, .error-container {
    display: flex;
    flex-direction: column;
    align-items: center;
    justify-content: center;
    padding: 3rem;    text-align: center;
    color: rgba(255, 255, 255, 0.7);
  }

  .error-message {
    color: #ef4444;
    margin-bottom: 1rem;
  }

  .manual-mods-container {
    display: flex;
    flex-direction: column;
    gap: 1rem;
  }

  .actions-header {
    display: flex;
    justify-content: space-between;
    align-items: center;
    padding: 0 0.5rem;
  }

  .actions-header button {
    padding: 0.5rem 1rem;
    border: none;
    border-radius: 4px;
    font-size: 0.875rem;
    font-weight: 500;
    cursor: pointer;
    transition: all 0.2s ease;
  }

  .check-updates-btn {
    background: rgba(34, 197, 94, 0.2);
    color: #22c55e;
    border: 1px solid rgba(34, 197, 94, 0.3);
  }

  .check-updates-btn:hover:not(:disabled) {
    background: rgba(34, 197, 94, 0.3);
    border-color: rgba(34, 197, 94, 0.5);
  }

  .check-updates-btn:disabled {
    opacity: 0.6;
    cursor: not-allowed;
  }

  .refresh-btn {
    background: rgba(156, 163, 175, 0.2);
    color: #9ca3af;
    border: 1px solid rgba(156, 163, 175, 0.3);
  }

  .refresh-btn:hover {
    background: rgba(156, 163, 175, 0.3);
    border-color: rgba(156, 163, 175, 0.5);
  }

  .grid-header {
    display: grid;
    grid-template-columns: 2.5fr 1fr 1fr 2fr;
    gap: 1rem;
    padding: 0.75rem 1rem;
    background: rgba(255, 255, 255, 0.05);
    border-radius: 6px;
    font-weight: 600;
    color: rgba(255, 255, 255, 0.9);
    border: 1px solid rgba(255, 255, 255, 0.1);
  }

  .header-cell {
    display: flex;
    align-items: center;
  }

  .header-cell:nth-child(2),
  .header-cell:nth-child(3) {
    justify-content: center;
  }

  .header-cell:nth-child(4) {
    justify-content: flex-end;
  }

  .mods-grid {
    display: flex;
    flex-direction: column;
    gap: 0.5rem;
  }
  .mod-card {
    background: rgba(255, 255, 255, 0.05);
    border-radius: 8px;
    border: 1px solid rgba(255, 255, 255, 0.1);
    overflow: hidden;
    transition: all 0.3s ease; /* Increased duration for smoother transitions */
  }

  .mod-card:hover {
    background: rgba(255, 255, 255, 0.08);
    border-color: rgba(255, 255, 255, 0.2);
  }

  .mod-card.disabled {
    opacity: 0.7;
    background: rgba(139, 69, 19, 0.15);
    transition: all 0.3s ease; /* Smooth transition when disabling */
  }

  .mod-header {
    display: grid;
    grid-template-columns: 2.5fr 1fr 1fr 2fr;
    gap: 1rem;
    padding: 1rem;
    align-items: center;
    cursor: pointer;
  }

  .mod-info {
    display: flex;
    flex-direction: column;
    gap: 0.25rem;
    min-width: 0; /* Allow shrinking */
  }

  .mod-name {
    font-weight: 600;
    color: white;
    font-size: 1rem;
    word-break: break-word;
  }

  .mod-authors {
    font-size: 0.8rem;
    color: rgba(255, 255, 255, 0.6);
  }

  .mod-file-info {
    display: flex;
    gap: 1rem;
    font-size: 0.75rem;
    color: rgba(255, 255, 255, 0.5);
  }

  .mod-status {
    display: flex;
    flex-direction: column;
    align-items: center;
    gap: 0.25rem;
  }
  .status-tag {
    padding: 0.25rem 0.5rem;
    border-radius: 4px;
    font-size: 0.75rem;
    font-weight: 500;
    text-transform: uppercase;
    transition: all 0.3s ease; /* Smooth transition for status changes */
  }

  .status-tag.enabled {
    background: rgba(34, 197, 94, 0.2);
    color: #22c55e;
    border: 1px solid rgba(34, 197, 94, 0.3);
  }

  .status-tag.disabled {
    background: rgba(239, 68, 68, 0.2);
    color: #ef4444;
    border: 1px solid rgba(239, 68, 68, 0.3);
  }

  .update-badge {
    padding: 0.2rem 0.4rem;
    background: rgba(251, 191, 36, 0.2);
    color: #fbbf24;
    border: 1px solid rgba(251, 191, 36, 0.3);
    border-radius: 4px;
    font-size: 0.65rem;
    font-weight: 500;
    text-transform: uppercase;
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

  .update-btn {
    background: rgba(251, 191, 36, 0.2);
    color: #fbbf24;
    border: 1px solid rgba(251, 191, 36, 0.3);
  }

  .update-btn:hover:not(:disabled) {
    background: rgba(251, 191, 36, 0.3);
    border-color: rgba(251, 191, 36, 0.5);
  }

  .update-btn:disabled {
    opacity: 0.6;
    cursor: not-allowed;
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

  .mod-details {
    padding: 1rem;
    background: rgba(0, 0, 0, 0.2);
    border-top: 1px solid rgba(255, 255, 255, 0.1);
  }

  .details-grid {
    display: grid;
    gap: 0.75rem;
  }

  .detail-item {
    display: grid;
    grid-template-columns: 120px 1fr;
    gap: 0.5rem;
    align-items: start;
  }

  .detail-item.description {
    grid-template-columns: 120px 1fr;
  }
  .detail-item .detail-label {
    font-weight: 500;
    color: rgba(255, 255, 255, 0.8);
    font-size: 0.85rem;
  }

  .detail-item span {
    color: rgba(255, 255, 255, 0.9);
    font-size: 0.85rem;
    word-break: break-word;
  }

  .loader-tag {
    padding: 0.2rem 0.4rem;
    background: rgba(139, 92, 246, 0.2);
    color: #8b5cf6;
    border: 1px solid rgba(139, 92, 246, 0.3);
    border-radius: 4px;
    font-size: 0.75rem;
    font-weight: 500;
  }

  .game-versions {
    display: flex;
    flex-wrap: wrap;
    gap: 0.25rem;
  }

  .version-chip {
    padding: 0.2rem 0.4rem;
    background: rgba(59, 130, 246, 0.2);
    color: #3b82f6;
    border: 1px solid rgba(59, 130, 246, 0.3);
    border-radius: 4px;
    font-size: 0.7rem;
    font-weight: 500;
  }
</style>
