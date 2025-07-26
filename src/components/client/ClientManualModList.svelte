<script lang="ts">
  import { onMount } from 'svelte';
  
  import { SvelteSet } from 'svelte/reactivity';import { get } from 'svelte/store'; // Import get
  import ConfirmationDialog from '../common/ConfirmationDialog.svelte';
  import { serverManagedFiles, minecraftVersion } from '../../stores/modStore';

  // Create event dispatcher
  const dispatch = (name: string, detail?: any) => {
    const event = new CustomEvent(name, { detail });
    document.dispatchEvent(event);
  };

  export let clientPath = '';
  export let refreshTrigger = 0; // Prop to trigger refresh when acknowledgments change  
  export let modSyncStatus = null;
  export let clientModVersionUpdates = null; // Client mod version updates from server compatibility check
  
  let mods = [];
  let loading = true;
  let error = '';
  let checkingUpdates = false;
  let updatingMods= new SvelteSet();
  let showRemoveDialog = false;
  let modToRemove= null;
  
  // Track which mods are currently being toggled
  let togglingMods= new SvelteSet();

  onMount(async () => {
    await loadManualMods();
  });  // React to clientPath changes
  $: if (clientPath) {
    loadManualMods();
  }
    // React to serverManagedFiles changes - this fixes the duplicate mods issue
  $: if ($serverManagedFiles) {
    loadManualMods();
  }
  
  // React to acknowledgment changes - this fixes the transition after acknowledgment
  $: if (refreshTrigger > 0) {
    loadManualMods();
  }
  // React to modSyncStatus changes - catches acknowledgment state changes
  $: if (modSyncStatus) {
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
        // Filter out server-managed mods entirely
        // Also filter out mods that are awaiting acknowledgment (they should only appear in required mods section)
        const pendingAckSet = new SvelteSet(
          (modSyncStatus?.clientModChanges?.removals || [])
            .filter((r: any) => r.action === 'acknowledge_dependency')
            .map((r: any) => r.fileName.toLowerCase())
        );        // Filter out mods that are pending removal from originally required mods
        // (they should only appear in required mods section with removal action)
        // But keep mods that were originally optional - they should appear in optional section
        const pendingRemovalSet = new SvelteSet(
          (modSyncStatus?.clientModChanges?.removals || [])
            .filter((r: any) => r.action === 'remove_needed' && r.wasRequired === true)
            .map((r: any) => r.fileName.toLowerCase())
        );mods = result.mods.filter(m => {
          const lower = m.fileName.toLowerCase();
          const isServerManaged = managedFilesSet.has(lower);
          const needsAck = pendingAckSet.has(lower);
          const needsRemoval = pendingRemovalSet.has(lower);

          // Only include mods that are:
          // 1. Not server-managed
          // 2. Not awaiting acknowledgment
          // 3. Not awaiting removal
          return !isServerManaged && !needsAck && !needsRemoval;
        });
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
        mods = mods.map((mod: any) => {
          const updateInfo = result.updates.find((u: any) => u.fileName === mod.fileName);
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
  async function toggleMod(mod: any) {
    // Mark this mod as being toggled
    togglingMods.add(mod.fileName);
    togglingMods = new SvelteSet(togglingMods); // Trigger reactivity
    
    // Dispatch to parent component for backend call
    dispatch('toggle', {
        fileName: mod.fileName,
      enabled: !mod.enabled
      });
  }
  async function updateMod(mod) {
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

  function promptRemove(mod) {
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
      } else {
        // Mod successfully removed - dispatch event to refresh parent state
        dispatch('mod-removed', { fileName: mod.fileName });
      }
    } catch (err) {
      // Restore the mod if an error occurred
      mods = originalMods;
      error = err.message || 'Failed to remove mod';
    }
  }

  // Helper function to get client mod version update info for a mod
  function getClientModVersionUpdate(mod) {
    if (!clientModVersionUpdates?.updates) return null;
    
    return clientModVersionUpdates.updates.find(update => 
      update.fileName.toLowerCase() === mod.fileName.toLowerCase()
    );
  }

  // Function to handle toggle completion (called from parent)
  export function onToggleComplete(fileName) {
    togglingMods.delete(fileName);
    togglingMods = new SvelteSet(togglingMods); // Trigger reactivity
    
    // Update the local mod state to reflect the successful toggle
    const modIndex = mods.findIndex(m => m.fileName === fileName);
    if (modIndex !== -1) {
      mods[modIndex].enabled = !mods[modIndex].enabled;
      mods = mods; // Trigger reactivity
    }
  }
</script>

{#if loading}
  <div class="loading-container">
    <p>Loading client downloaded mods...</p>
    <!-- You can add a spinner or a more elaborate loading animation here -->
  </div>
{:else if error}
  <div class="error-container">
    <p class="error-message">Error loading mods: {error}</p>
    <button on:click={loadManualMods} class="retry-button">Retry</button>
  </div>
{:else}
  <div class="manual-mods-container">
    <!-- Integrated table with header -->
    <div class="table-container">
      <table class="client-mods-table client-table">
        <thead>
          <!-- Section header as first row -->
          <tr class="section-header">
            <td colspan="5">
              <div class="section-header-content">
                <h3>Client Downloaded Mods</h3>
                <p class="section-description">Mods installed by you (not synced from server).</p>
                
                <!-- Check Updates button within header -->
                <div class="header-actions">
                  <button 
                    class="header-btn" 
                    on:click={checkForUpdates}
                    disabled={checkingUpdates}
                    title={checkingUpdates ? 'Checking for updates...' : 'Check for Updates'}
                  >
                    {checkingUpdates ? '⏳' : '🔄'} Check Updates
                  </button>
                </div>
              </div>
            </td>
          </tr>
          
          <!-- Column headers -->
          {#if mods.length > 0}
            <tr class="column-headers">
              <th>Mod Name</th>
              <th class="status">Status</th>
              <th class="ver">Version</th>
              <th class="upd">Update</th>
              <th class="act">Actions</th>
            </tr>
          {/if}
        </thead>
        <tbody>
          {#each mods as mod (mod.fileName)}
            <tr class:disabled={!mod.enabled}>
              
              <!-- Mod Name -->
              <td>
                <div class="mod-name-cell">
                  <strong>{mod.name || mod.fileName}</strong>
                </div>
              </td>

              <!-- Status -->
              <td class="status">
                {#if $serverManagedFiles.has(mod.fileName.toLowerCase())}
                  <span class="tag server">🔒 Server</span>
                {:else}
                  <span class="tag {mod.enabled ? 'ok' : 'disabled'}">
                    {mod.enabled ? 'Enabled' : 'Disabled'}
                  </span>
                {/if}
              </td>

              <!-- Version -->
              <td class="ver">
                {#if getClientModVersionUpdate(mod)}
                  {@const updateInfo = getClientModVersionUpdate(mod)}
                  <div class="version-update">
                    <code class="current-ver">{mod.version || 'Unknown'}</code>
                    <span class="version-arrow">→</span>
                    <code class="new-ver">{updateInfo.newVersion}</code>
                  </div>
                {:else if mod.version}
                  <code>{mod.version}</code>
                {:else}
                  <span class="no-version">—</span>
                {/if}
              </td>

              <!-- Update -->
              <td class="upd">
                {#if getClientModVersionUpdate(mod)}
                  <button class="tag new clickable" 
                          on:click={() => {}}
                          title="Update for MC {clientModVersionUpdates.minecraftVersion}">
                    ↑ Client Update
                  </button>
                {:else if mod.hasUpdate}
                  <button class="tag new clickable" 
                          on:click={() => updateMod(mod)}
                          disabled={updatingMods.has(mod.fileName)}
                          title="Update to {mod.latestVersion}">
                    {updatingMods.has(mod.fileName) ? '⏳' : '↑'} {mod.latestVersion}
                  </button>
                {:else}
                  <span class="tag ok">Up to date</span>
                {/if}
              </td>

              <!-- Actions -->
              <td class="act">
                {#if !$serverManagedFiles.has(mod.fileName.toLowerCase())}
                  <div class="action-group">
                    {#if togglingMods.has(mod.fileName)}
                      <button class="toggle sm loading" disabled title="Processing...">
                        ⏳ Loading...
                      </button>
                    {:else}
                    <button class="toggle sm" 
                            class:primary={!mod.enabled}
                            class:warn={mod.enabled}
                            on:click={() => toggleMod(mod)}
                            title={mod.enabled ? 'Disable mod' : 'Enable mod'}>
                      {mod.enabled ? 'Disable' : 'Enable'}
                    </button>
                    {/if}
                    <button class="danger sm" on:click={() => promptRemove(mod)} title="Remove mod">
                      🗑️
                    </button>
                  </div>
                {:else}
                  <span class="server-tag">Server Managed</span>
                {/if}
              </td>
            </tr>
          {/each}
        </tbody>
        
        <!-- Empty state as table row -->
        {#if mods.length === 0}
          <tbody>
            <tr class="empty-state">
              <td colspan="5">
                <p>No client downloaded mods found.</p>
              </td>
            </tr>
          </tbody>
        {/if}
      </table>
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

<style>
  /* CSS variables matching other sections exactly */
  .manual-mods-container {
    --row-py: 3px;
    --cell-px: 6px;
    --col-ok: #14a047;
    --col-warn: #c9801f;
    --col-danger: #b33;
    --col-primary: #0a84ff;
    --bg-primary: #181818;
    --bg-secondary: #141414;
    --bg-tertiary: #1a1a1a;
    --text-primary: #ddd;
    --text-secondary: #aaa;
    --border-color: #333;
    width: 100%;
  }

  .loading-container, .error-container {
    display: flex;
    flex-direction: column;
    align-items: center;
    justify-content: center;
    padding: 3rem;
    text-align: center;
    color: rgba(255, 255, 255, 0.7);
  }

  /* Section header as table row */
  .section-header td {
    background-color: #1f2937;
    border-top: 3px solid #22c55e; /* Green for client downloaded */
    padding: 0.75rem var(--cell-px) !important;
  }

  .section-header-content {
    text-align: center;
    position: relative;
  }

  .section-header-content h3 {
    color: white;
    margin: 0 0 0.15rem 0;
    font-size: 1rem;
    font-weight: 600;
  }

  .section-header-content .section-description {
    color: #9ca3af;
    font-size: 0.8rem;
    margin: 0;
    line-height: 1.3;
  }

  .header-actions {
    position: absolute;
    top: 0;
    right: 0;
  }

  .header-btn {
    padding: 0.3rem 0.6rem;
    border: none;
    border-radius: 4px;
    font-size: 0.75rem;
    font-weight: 500;
    cursor: pointer;
    transition: background-color 0.2s;
    background-color: #374151;
    color: white;
    white-space: nowrap;
  }

  .header-btn:hover:not(:disabled) {
    background-color: #4b5563;
  }

  .header-btn:disabled {
    opacity: 0.5;
    cursor: not-allowed;
  }

  .error-message {
    color: #ef4444;
    margin-bottom: 1rem;
  }

  /* Table layout */
  .table-container {
    width: 100%;
    overflow-x: auto;
    border: 1px solid #374151;
    border-radius: 6px;
  }

  .client-mods-table {
    width: 100%;
    border-collapse: collapse;
    font-size: 0.9rem;
    background: linear-gradient(to bottom, var(--bg-primary), var(--bg-secondary));
    table-layout: auto;
  }

  .client-mods-table th,
  .client-mods-table td {
    padding: var(--row-py) var(--cell-px);
  }

  .client-mods-table tr {
    transition: background-color 0.15s, box-shadow 0.15s;
  }

  .client-mods-table thead {
    background: var(--bg-tertiary);
    position: sticky;
    top: 0;
    z-index: 6;
  }

  .client-mods-table th {
    text-align: center;
  }

  .client-mods-table th:first-child {
    text-align: left;
  }

  .client-mods-table tbody tr:nth-child(even) {
    background: rgba(24, 24, 24, 0.8);
  }

  .client-mods-table tbody tr:hover {
    background: #212121;
    box-shadow: 0 0 4px rgba(255, 255, 255, 0.1);
  }

  .client-mods-table tbody tr.disabled {
    opacity: 0.7;
    background: rgba(139, 69, 19, 0.15) !important;
    transition: all 0.3s ease;
  }

  /* Column widths - match the other sections exactly */
  .client-mods-table td:first-child {
    text-align: left;
  }

  .client-mods-table th.status,
  .client-mods-table td.status {
    width: 80px;
    min-width: 70px;
    text-align: center;
  }

  .client-mods-table th.ver,
  .client-mods-table td.ver {
    width: 100px;
    min-width: 80px;
    text-align: center;
  }

  .client-mods-table th.upd,
  .client-mods-table td.upd {
    width: 100px;
    min-width: 90px;
    text-align: center;
  }

  .client-mods-table th.act,
  .client-mods-table td.act {
    width: 120px;
    min-width: 110px;
    text-align: center;
  }

  /* Mod name cell */
  .mod-name-cell strong {
    color: var(--text-primary);
    font-weight: 600;
    word-break: break-word;
  }

  /* Status tags */
  .tag {
    padding: 1px 6px;
    border-radius: 3px;
    font-size: 0.75rem;
    font-weight: 500;
    text-align: center;
    white-space: nowrap;
  }

  .tag.ok {
    background: rgba(20, 160, 71, 0.2);
    color: var(--col-ok);
  }

  .tag.new {
    background: rgba(10, 132, 255, 0.2);
    color: var(--col-primary);
  }

  .tag.server {
    background: rgba(139, 92, 246, 0.2);
    color: #8b5cf6;
  }

  .tag.disabled {
    background: rgba(179, 51, 51, 0.2);
    color: var(--col-danger);
  }

  .tag.clickable {
    cursor: pointer;
    transition: all 0.2s;
  }

  .tag.clickable:hover:not(:disabled) {
    opacity: 0.8;
    transform: translateY(-1px);
  }

  .tag.clickable:disabled {
    opacity: 0.6;
    cursor: not-allowed;
  }

  /* Version display */
  .ver code {
    background: var(--border-color);
    color: var(--text-primary);
    padding: 2px 4px;
    border-radius: 3px;
    font-size: 0.75rem;
  }

  .no-version {
    color: var(--text-secondary);
    font-style: italic;
  }

  .version-update {
    display: flex;
    align-items: center;
    gap: 4px;
    font-size: 0.75rem;
  }

  .current-ver {
    background: rgba(107, 114, 128, 0.2);
    color: #9ca3af;
  }

  .new-ver {
    background: rgba(34, 197, 94, 0.2);
    color: #22c55e;
  }

  .version-arrow {
    color: var(--text-secondary);
    font-weight: bold;
  }

  /* Buttons */
  .primary, .danger, .warn, .toggle {
    padding: 2px 8px;
    border: none;
    border-radius: 3px;
    font-size: 0.75rem;
    font-weight: 500;
    cursor: pointer;
    transition: all 0.2s;
  }

  .sm {
    font-size: 0.7rem;
    padding: 1px 6px;
  }

  .primary {
    background: var(--col-primary);
    color: white;
  }

  .primary:hover {
    background: #0066cc;
  }

  .danger {
    background: var(--col-danger);
    color: white;
  }

  .danger:hover {
    background: #990000;
  }

  .warn {
    background: var(--col-warn);
    color: white;
  }

  .warn:hover {
    background: #a66500;
  }

  .toggle {
    background: rgba(168, 85, 247, 0.2);
    color: #a855f7;
    border: 1px solid rgba(168, 85, 247, 0.3);
  }

  .toggle:hover {
    background: rgba(168, 85, 247, 0.3);
  }

  /* Action groups */
  .action-group {
    display: flex;
    gap: 4px;
    align-items: center;
    justify-content: center;
  }

  .server-tag {
    font-size: 0.75rem;
    color: #8b5cf6;
    font-style: italic;
    text-align: center;
  }

  /* Empty state */
  .empty-state td {
    text-align: center;
    padding: 2rem var(--cell-px) !important;
    color: #9ca3af;
    font-style: italic;
  }
</style>
