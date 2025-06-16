<script lang="ts">  import { createEventDispatcher } from 'svelte';  // Types
  interface Mod {
    fileName: string;
    size?: number;
    lastModified?: string;
    location?: string;
    name?: string;
    versionNumber?: string;
    projectId?: string;
    needsRemoval?: boolean;
    removalReason?: string;
    removalAction?: string;
  }
  interface ModSyncStatus {
    synchronized: boolean;
    missingMods?: string[];
    missingOptionalMods?: string[];
    totalRequired?: number;
    totalOptional?: number;    totalPresent?: number;
    totalOptionalPresent?: number;
    presentEnabledMods?: string[];
    presentDisabledMods?: string[];
    // New response structure
    requiredRemovals?: Array<{
      fileName: string;
      reason: string;
    }>;
    optionalRemovals?: Array<{
      fileName: string;
      reason: string;
    }>;
    acknowledgments?: Array<{
      fileName: string;
      reason: string;
    }>;
    // Legacy structure (temporary)
    clientModChanges?: {
      updates?: Array<{
        name: string;
        fileName: string;
        currentVersion: string;
        serverVersion: string;
        action: string;
      }>;
      removals?: Array<{
        name: string;
        fileName: string;
        reason: string;
        action: string;
      }>;
      newDownloads?: string[];
    };
  }
  // Props
  export let mods: Mod[] = [];
  export let type: 'required' | 'optional' = 'required';
  export let modSyncStatus: ModSyncStatus | null = null;
  export let serverManagedFiles: Set<string> = new Set();
  // Create event dispatcher
  const dispatch = createEventDispatcher();  // Local state to track mod enabled/disabled status for optimistic updates
  let localModStates: Record<string, { enabled: boolean }> = {};
  let optimisticUpdates: Set<string> = new Set(); // Track which mods have pending optimistic updates  // Initialize local states when mods change
  $: if (mods && modSyncStatus) {
    // Initialize local state for each mod based on current sync status
    // But don't override mods that have pending optimistic updates
    localModStates = mods.reduce((acc, mod) => {
      if (optimisticUpdates.has(mod.fileName)) {
        // Keep the existing optimistic state
        acc[mod.fileName] = localModStates[mod.fileName] || { enabled: true };
      } else {
        // Use the backend state
        const isDisabled = modSyncStatus.presentDisabledMods?.includes(mod.fileName) || false;
        acc[mod.fileName] = { enabled: !isDisabled };
      }
      return acc;
    }, {} as Record<string, { enabled: boolean }>);
  }

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
    }    // Check if this mod is server-managed (use lowercase for comparison)
    const isServerManaged = serverManagedFiles.has(mod.fileName.toLowerCase());
    
    // Only show "server mod" status for required mods, not optional mods
    if (isServerManaged && type === 'required') {
      return 'server mod';
    }    // For optional mods, check local state first for optimistic updates
    if (type === 'optional') {
      const localState = localModStates[mod.fileName];
      if (localState) {
        return localState.enabled ? 'installed' : 'disabled';
      }
      // Fallback to sync status if local state not available
      if (modSyncStatus.presentDisabledMods && modSyncStatus.presentDisabledMods.includes(mod.fileName)) {
        return 'disabled';
      }
    }
    
    return 'installed';
  }  // Check if a mod needs to be removed
  function needsRemoval(mod: Mod): boolean {
    // Check if the mod object itself has the needsRemoval property
    if (mod.needsRemoval) return true;
    
    // Check in the new response structure
    if (type === 'required' && modSyncStatus?.requiredRemovals) {
      return modSyncStatus.requiredRemovals.some(removal => 
        removal.fileName.toLowerCase() === mod.fileName.toLowerCase()
      );
    }
    
    if (type === 'optional' && modSyncStatus?.optionalRemovals) {
      return modSyncStatus.optionalRemovals.some(removal => 
        removal.fileName.toLowerCase() === mod.fileName.toLowerCase()
      );
    }
    
    return false;
  }

  // Check if a mod is kept due to dependency
  function needsAcknowledgment(mod: Mod): boolean {
    if (!modSyncStatus?.acknowledgments) return false;
    
    return modSyncStatus.acknowledgments.some(ack => 
      ack.fileName.toLowerCase() === mod.fileName.toLowerCase()
    );
  }

  // Get removal info for a mod
  function getRemovalInfo(mod: Mod) {
    // Check in the new response structure
    if (type === 'required' && modSyncStatus?.requiredRemovals) {
      return modSyncStatus.requiredRemovals.find(removal => 
        removal.fileName.toLowerCase() === mod.fileName.toLowerCase()
      );
    }
    
    if (type === 'optional' && modSyncStatus?.optionalRemovals) {
      return modSyncStatus.optionalRemovals.find(removal => 
        removal.fileName.toLowerCase() === mod.fileName.toLowerCase()
      );
    }
    
    return null;
  }

  // Get dependency acknowledgment info for a mod
  function getAcknowledgmentInfo(mod: Mod) {
    if (!modSyncStatus?.acknowledgments) return null;
    
    return modSyncStatus.acknowledgments.find(ack => 
      ack.fileName.toLowerCase() === mod.fileName.toLowerCase()
    );
  }

  // Format file size
  function formatFileSize(bytes: number): string {
    if (!bytes) return 'Unknown size';
    
    const sizes = ['Bytes', 'KB', 'MB', 'GB'];
    if (bytes === 0) return '0 Bytes';
    
    const i = parseInt(Math.floor(Math.log(bytes) / Math.log(1024)).toString(), 10);
    return Math.round(bytes / Math.pow(1024, i) * 100) / 100 + ' ' + sizes[i];  }
  // Handle mod toggle for optional mods
  function handleToggle(mod: Mod, enabled: boolean): void {
    if (type === 'required') return; // Required mods cannot be toggled

    // Mark this mod as having a pending optimistic update
    optimisticUpdates.add(mod.fileName);
    
    // Optimistic UI update - update the local state immediately
    if (!localModStates[mod.fileName]) {
      localModStates[mod.fileName] = { enabled: !enabled };
    }
    localModStates[mod.fileName].enabled = enabled;
    localModStates = localModStates; // Trigger reactivity

    // Dispatch to parent component for backend call
    dispatch('toggle', {
      fileName: mod.fileName,
      enabled: enabled
    });
    
    // Clear optimistic update flag after a short delay
    // This allows the backend state to eventually take over
    setTimeout(() => {
      optimisticUpdates.delete(mod.fileName);
      optimisticUpdates = new Set(optimisticUpdates); // Trigger reactivity
    }, 2000);
  }
  // Handle mod deletion
  function handleDelete(mod: Mod): void {
    dispatch('delete', { fileName: mod.fileName });
  }  // Handle mod removal (for server-managed mods no longer required)
  function handleRemove(mod: Mod): void {
    dispatch('remove', { fileName: mod.fileName });
  }

  // Handle dependency acknowledgment
  function handleAcknowledge(mod: Mod): void {
    dispatch('acknowledge', { fileName: mod.fileName });
  }

  // Handle download for missing mods
  function handleDownload(): void {
    dispatch('download');
  }

  // Handle download for single optional mod
  function handleDownloadSingle(mod: Mod): void {
    dispatch('downloadSingle', { mod });
  }


</script>

<div class="client-mod-list">
  {#if mods.length === 0}
    <div class="empty-state">
      <p>No {type} mods found.</p>
    </div>  {:else}
    <div class="grid-header">
      <div class="header-cell">Mod Details</div>
      <div class="header-cell">Status</div>
      <div class="header-cell">Version</div>
      <div class="header-cell">Actions</div>
    </div>
      <div class="mods-grid">
      {#each mods as mod (mod.fileName)}
        <div class="mod-card {type} {getModStatus(mod) === 'disabled' ? 'disabled' : ''}">
          <div class="mod-info">
            <div class="mod-name">{mod.name || mod.fileName}</div>
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
          </div>            <div class="mod-status">
            {#if needsRemoval(mod)}
              <span class="status-badge removal">⚠️ Needs Removal</span>
            {:else if needsAcknowledgment(mod)}
              <span class="status-badge acknowledgment">🔗 Needs Acknowledgment</span>
            {:else if getModStatus(mod) === 'server mod'}
              <span class="status-badge server-mod">🔒 Server Mod</span>
            {:else if getModStatus(mod) === 'installed'}
              <span class="status-badge installed">Enabled</span>
            {:else if getModStatus(mod) === 'disabled'}
              <span class="status-badge disabled">Disabled</span>
            {:else if getModStatus(mod) === 'missing'}
              <span class="status-badge missing">❌ Missing</span>
            {:else}
              <span class="status-badge unknown">❓ Unknown</span>
            {/if}
          </div>
          
          <div class="mod-version">
            {#if mod.versionNumber}
              <span class="version-tag">v{mod.versionNumber}</span>
            {:else}
              <span class="version-tag unknown">Unknown</span>
            {/if}
          </div>          <div class="mod-actions">
            {#if type === 'required'}
              {#if needsAcknowledgment(mod)}
                {@const acknowledgmentInfo = getAcknowledgmentInfo(mod)}
                <div class="dependency-notification">
                  <span class="dependency-reason">🔗 {acknowledgmentInfo?.reason || 'required as dependency by client downloaded mods'}</span>
                  <button class="action-btn acknowledge-btn" on:click={() => handleAcknowledge(mod)} title="Acknowledge this dependency">
                    ✓ Acknowledge
                  </button>
                </div>
              {:else if needsRemoval(mod)}
                {@const removalInfo = getRemovalInfo(mod)}
                <span class="removal-reason">{removalInfo?.reason || 'No longer required'}</span>
                <button class="action-btn remove-btn" on:click={() => handleRemove(mod)} title="Remove this mod">
                  🗑️ Remove
                </button>
              {:else}
                <span class="required-label">Required</span>
                {#if getModStatus(mod) === 'missing'}
                  <button class="download-button" on:click={handleDownload}>
                    📥 Download
                  </button>
                {/if}
              {/if}
            {:else if type === 'optional'}
              {#if getModStatus(mod) === 'missing'}
                <button class="download-button" on:click={() => handleDownloadSingle(mod)}>
                  📥 Download
                </button>
              {:else}
                <button 
                  class="action-btn toggle-btn"
                  on:click={() => handleToggle(mod, getModStatus(mod) !== 'installed')}
                  title={getModStatus(mod) === 'installed' ? 'Disable mod' : 'Enable mod'}
                >
                  {#if getModStatus(mod) === 'installed'}
                    Disable
                  {:else}
                    Enable
                  {/if}
                </button>
              {/if}
              {#if getModStatus(mod) !== 'missing'}
                <button class="action-btn delete-btn" on:click={() => handleDelete(mod)} title="Remove mod">
                  Remove
                </button>
              {/if}
            {/if}
          </div>
        </div>
      {/each}
    </div>    <!-- Summary for missing mods -->
    {#if type === 'required' && modSyncStatus && modSyncStatus.missingMods && modSyncStatus.missingMods.length > 0}
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
    
    <!-- Summary for missing optional mods -->
    {#if type === 'optional' && modSyncStatus && modSyncStatus.missingOptionalMods && modSyncStatus.missingOptionalMods.length > 0}
      <div class="summary">
        <div class="missing-summary optional">
          <span class="summary-text">
            {modSyncStatus.missingOptionalMods.length} optional mod(s) available for download
          </span>
          <button class="download-all-button optional" on:click={handleDownload}>
            📥 Download All Optional
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
    margin-bottom: 0.5rem;
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
    transition: all 0.3s ease;
    display: grid;
    grid-template-columns: 2.5fr 1fr 1fr 2fr;
    gap: 1rem;
    padding: 1rem;
    align-items: center;
  }

  .mod-card:hover {
    background: rgba(255, 255, 255, 0.08);
    border-color: rgba(255, 255, 255, 0.2);
  }

  .mod-card.required {
    border-left: 4px solid #ef4444;
  }

  .mod-card.optional {
    border-left: 4px solid #3b82f6;
  }

  .mod-card.disabled {
    opacity: 0.7;
    background: rgba(139, 69, 19, 0.15);
    transition: all 0.3s ease; /* Smooth transition when disabling */
  }
  
  .mod-info {
    display: flex;
    flex-direction: column;
    gap: 0.25rem;
    min-width: 0;
  }

  .mod-name {
    color: white;
    font-weight: 600;
    font-size: 1rem;
    word-break: break-word;
  }

  .mod-details {
    display: flex;
    gap: 1rem;
    font-size: 0.75rem;
    color: rgba(255, 255, 255, 0.5);
    flex-wrap: wrap;
  }

  .mod-status {
    display: flex;
    justify-content: center;
    align-items: center;
  }

  .status-badge {
    padding: 0.25rem 0.5rem;
    border-radius: 4px;
    font-size: 0.75rem;
    font-weight: 500;
    text-align: center;
  }
  .status-badge.installed {
    background-color: rgba(16, 185, 129, 0.2);
    color: #10b981;
  }

  .status-badge.server-mod {
    background-color: rgba(139, 92, 246, 0.2);
    color: #8b5cf6;
    border: 1px solid rgba(139, 92, 246, 0.3);
  }
  .status-badge.disabled {
    background-color: rgba(239, 68, 68, 0.2);
    color: #ef4444;
    border: 1px solid rgba(239, 68, 68, 0.3);
  }
  .status-badge.missing {
    background-color: rgba(239, 68, 68, 0.2);
    color: #ef4444;
  }
  .status-badge.removal {
    background-color: rgba(245, 158, 11, 0.2);
    color: #f59e0b;
    border: 1px solid rgba(245, 158, 11, 0.3);
  }

  .status-badge.acknowledgment {
    background-color: rgba(16, 185, 129, 0.2);
    color: #10b981;
    border: 1px solid rgba(16, 185, 129, 0.3);
  }

  .status-badge.acknowledged {
    background-color: rgba(16, 185, 129, 0.1);
    color: #059669;
    border: 1px solid rgba(16, 185, 129, 0.2);
  }

  .status-badge.unknown {
    background-color: rgba(107, 114, 128, 0.2);
    color: #9ca3af;
  }

  .mod-version {
    display: flex;
    justify-content: center;
    align-items: center;
  }

  .version-tag {
    padding: 0.25rem 0.5rem;
    border-radius: 4px;
    font-size: 0.75rem;
    font-weight: 500;
    background: rgba(59, 130, 246, 0.2);
    color: #3b82f6;
    border: 1px solid rgba(59, 130, 246, 0.3);
    text-align: center;
  }

  .version-tag.unknown {
    background: rgba(156, 163, 175, 0.2);
    color: #9ca3af;
    border: 1px solid rgba(156, 163, 175, 0.3);
  }

  .mod-actions {
    display: flex;
    justify-content: flex-end;
    align-items: center;
    gap: 0.5rem;
    flex-wrap: wrap;
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
    padding: 0.4rem 0.75rem;
    font-size: 0.75rem;
    cursor: pointer;
    transition: background-color 0.2s;
  }

  .download-button:hover, .download-all-button:hover {
    background-color: #2563eb;
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

  .toggle-btn {
    background: rgba(168, 85, 247, 0.2);
    color: #a855f7;
    border: 1px solid rgba(168, 85, 247, 0.3);
  }

  .toggle-btn:hover:not(:disabled) {
    background: rgba(168, 85, 247, 0.3);
    border-color: rgba(168, 85, 247, 0.5);
  }

  .toggle-btn:disabled {
    opacity: 0.6;
    cursor: not-allowed;
    background: rgba(156, 163, 175, 0.2);
    color: #9ca3af;
    border: 1px solid rgba(156, 163, 175, 0.3);
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

  .remove-btn {
    background: rgba(245, 158, 11, 0.2);
    color: #f59e0b;
    border: 1px solid rgba(245, 158, 11, 0.3);
  }
  
  .remove-btn:hover {
    background: rgba(245, 158, 11, 0.3);
    border-color: rgba(245, 158, 11, 0.5);
  }
  .removal-reason {
    font-size: 0.8rem;
    color: rgba(255, 255, 255, 0.7);
    font-style: italic;
    margin-right: 0.5rem;
  }

  .dependency-notification {
    display: flex;
    flex-direction: column;
    align-items: flex-end;
    gap: 0.3rem;
  }

  .dependency-reason {
    font-size: 0.8rem;
    color: #10b981;
    font-style: italic;
    text-align: right;
  }

  .acknowledge-btn {
    background: rgba(16, 185, 129, 0.2);
    color: #10b981;
    border: 1px solid rgba(16, 185, 129, 0.3);
  }
    .acknowledge-btn:hover {
    background: rgba(16, 185, 129, 0.3);
    border-color: rgba(16, 185, 129, 0.5);
  }

  .dependency-notification.acknowledged {
    opacity: 0.8;
  }

  .acknowledged-label {
    font-size: 0.75rem;
    color: #10b981;
    background: rgba(16, 185, 129, 0.1);
    padding: 0.2rem 0.5rem;
    border-radius: 0.25rem;
    border: 1px solid rgba(16, 185, 129, 0.2);
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

  .missing-summary.optional {
    background-color: rgba(59, 130, 246, 0.1);
    border-color: rgba(59, 130, 246, 0.3);
  }

  .summary-text {
    color: #f59e0b;
    font-weight: 500;
  }

  .missing-summary.optional .summary-text {
    color: #3b82f6;
  }

  .download-all-button.optional {
    background-color: #3b82f6;
  }

  .download-all-button.optional:hover {
    background-color: #2563eb;
  }
</style>