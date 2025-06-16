<script lang="ts">
  import { createEventDispatcher } from 'svelte';  // Types
  interface ModSyncStatus {
    synchronized: boolean;
    needsDownload?: number;
    needsOptionalDownload?: number;
    needsAcknowledgment?: number;
    needsRemoval?: number;
    totalRequired?: number;
    totalOptional?: number;
    totalPresent?: number;
    totalOptionalPresent?: number;
    missingMods?: string[];
    missingOptionalMods?: string[];
    presentEnabledMods?: string[];
    presentDisabledMods?: string[];
  }

  // Props
  export let modSyncStatus: ModSyncStatus | null = null;
  export let requiredModsCount: number = 0;
  export let optionalModsCount: number = 0;

  // Create event dispatcher
  const dispatch = createEventDispatcher();

  function downloadRequired(): void {
    dispatch('download-required');
  }

  function downloadOptional(): void {
    dispatch('download-optional');
  }

  function refresh(): void {
    dispatch('refresh');
  }
</script>

<div class="mod-status-overview">
  <h3>Mod Status Overview</h3>
  
  <div class="status-cards">
    <!-- Required Mods Status -->
    <div class="status-card required">
      <div class="card-header">
        <span class="card-icon">🔒</span>
        <span class="card-title">Required Mods</span>
      </div>
      <div class="card-content">
        <div class="mod-count">{requiredModsCount}</div>        {#if modSyncStatus && modSyncStatus.totalRequired > 0}
          <div class="sync-status">
            {#if modSyncStatus.needsRemoval && modSyncStatus.needsRemoval > 0}
              <span class="status-text warning">🗑️ {modSyncStatus.needsRemoval} need removal</span>
            {:else if modSyncStatus.synchronized && (!modSyncStatus.needsAcknowledgment || modSyncStatus.needsAcknowledgment === 0)}
              <span class="status-text success">✅ All synchronized</span>
            {:else if modSyncStatus.needsAcknowledgment && modSyncStatus.needsAcknowledgment > 0}
              <span class="status-text info">🔗 {modSyncStatus.needsAcknowledgment} need acknowledgment</span>
            {:else}
              <span class="status-text warning">⚠️ {modSyncStatus.needsDownload} need download</span>
            {/if}
          </div>
          <div class="progress-info">
            {modSyncStatus.totalPresent} / {modSyncStatus.totalRequired} ready
          </div>
        {:else if requiredModsCount === 0}
          <div class="sync-status">
            <span class="status-text info">ℹ️ No required mods</span>
          </div>
        {:else}
          <div class="sync-status">
            <span class="status-text pending">⏳ Checking...</span>
          </div>
        {/if}
      </div>
    </div>

    <!-- Optional Mods Status -->
    <div class="status-card optional">
      <div class="card-header">
        <span class="card-icon">⚙️</span>
        <span class="card-title">Optional Mods</span>
      </div>
      <div class="card-content">
        <div class="mod-count">{optionalModsCount}</div>
        {#if modSyncStatus && modSyncStatus.totalOptional > 0}
          <div class="sync-status">
            {#if modSyncStatus.needsOptionalDownload && modSyncStatus.needsOptionalDownload > 0}
              <span class="status-text warning">⚠️ {modSyncStatus.needsOptionalDownload} missing</span>
            {:else}
              <span class="status-text success">✅ All available</span>
            {/if}
          </div>
          <div class="progress-info">
            {modSyncStatus.totalOptionalPresent || 0} / {modSyncStatus.totalOptional} present
          </div>
        {:else if optionalModsCount > 0}
          <div class="sync-status">
            <span class="status-text info">🎛️ User configurable</span>
          </div>
          <div class="progress-info">
            Can be enabled/disabled before play
          </div>
        {:else}
          <div class="sync-status">
            <span class="status-text info">ℹ️ None available</span>
          </div>
        {/if}
      </div>    </div>
  </div>
  <!-- Overall Status Message -->
  <div class="overall-status">
    {#if modSyncStatus}
      {#if modSyncStatus.synchronized && (!modSyncStatus.needsOptionalDownload || modSyncStatus.needsOptionalDownload === 0) && (!modSyncStatus.needsAcknowledgment || modSyncStatus.needsAcknowledgment === 0)}
        <div class="status-message success">
          <span class="status-icon">🎉</span>
          <div class="status-content">
            <h4>All mods are ready!</h4>
            <p>You can start playing immediately. All required mods are synchronized.</p>
          </div>
        </div>
      {:else if modSyncStatus.needsAcknowledgment && modSyncStatus.needsAcknowledgment > 0}
        <div class="status-message info">
          <span class="status-icon">🔗</span>
          <div class="status-content">
            <h4>Dependency notifications pending</h4>
            <p>There {modSyncStatus.needsAcknowledgment === 1 ? 'is' : 'are'} {modSyncStatus.needsAcknowledgment} mod{modSyncStatus.needsAcknowledgment > 1 ? 's' : ''} that {modSyncStatus.needsAcknowledgment === 1 ? 'is' : 'are'} being kept due to client-side dependencies. Please acknowledge {modSyncStatus.needsAcknowledgment === 1 ? 'it' : 'them'} in the mod list below.</p>
          </div>
        </div>
      {:else if modSyncStatus.synchronized && modSyncStatus.needsOptionalDownload > 0}
        <div class="status-message info">
          <span class="status-icon">ℹ️</span>
          <div class="status-content">
            <h4>Required mods ready!</h4>
            <p>You can start playing now. There {modSyncStatus.needsOptionalDownload === 1 ? 'is' : 'are'} {modSyncStatus.needsOptionalDownload} optional mod{modSyncStatus.needsOptionalDownload > 1 ? 's' : ''} available for download if you want {modSyncStatus.needsOptionalDownload === 1 ? 'it' : 'them'}.</p>
          </div>
        </div>      {:else if modSyncStatus.needsDownload > 0}
        <div class="status-message warning">
          <span class="status-icon">⚠️</span>
          <div class="status-content">
            <h4>Action required</h4>
            <p>You need to download {modSyncStatus.needsDownload} required mod{modSyncStatus.needsDownload > 1 ? 's' : ''} before you can play.</p>
          </div>
        </div>      {:else}
        {@const actualRemovals = [...((modSyncStatus as any).requiredRemovals || []), ...((modSyncStatus as any).optionalRemovals || [])]}
        {@const acknowledgments = (modSyncStatus as any).acknowledgments || []}
        
        {#if actualRemovals.length > 0 || acknowledgments.length > 0}
          <div class="status-message warning">
            <span class="status-icon">🔄</span>
            <div class="status-content">
              <h4>Mod changes needed</h4>
              {#if actualRemovals.length > 0 && acknowledgments.length > 0}
                <p>You need to remove {actualRemovals.length} mod{actualRemovals.length > 1 ? 's' : ''} and acknowledge {acknowledgments.length} dependenc{acknowledgments.length > 1 ? 'ies' : 'y'}.</p>
              {:else if actualRemovals.length > 0}
                <p>You need to remove {actualRemovals.length} mod{actualRemovals.length > 1 ? 's' : ''} that {actualRemovals.length > 1 ? 'are' : 'is'} no longer required by the server.</p>
              {:else if acknowledgments.length > 0}
                <p>You need to acknowledge {acknowledgments.length} mod{acknowledgments.length > 1 ? 's' : ''} that {acknowledgments.length > 1 ? 'are' : 'is'} being kept as dependencies.</p>
              {/if}
            </div>
          </div>
        {:else}
          <div class="status-message info">
            <span class="status-icon">🔄</span>
            <div class="status-content">
              <h4>Checking mod status...</h4>
              <p>Please wait while we verify your mod installation.</p>
            </div>
          </div>
        {/if}
      {/if}
    {:else}
      <div class="status-message info">
        <span class="status-icon">📡</span>
        <div class="status-content">
          <h4>Connecting to server...</h4>
          <p>Fetching mod requirements from the server.</p>
        </div>
      </div>
    {/if}
  </div>  <!-- Action Buttons -->
  <div class="action-buttons">
    {#if modSyncStatus && !modSyncStatus.synchronized}
      <!-- Use same logic as Play tab for consistent button text -->
      {#if modSyncStatus.needsDownload > 0}
        <button class="download-action-button required" on:click={downloadRequired}>
          📥 Download Required Mods ({modSyncStatus.needsDownload})
        </button>      {:else}
        {@const actualRemovals = [...((modSyncStatus as any).requiredRemovals || []), ...((modSyncStatus as any).optionalRemovals || [])]}
        {@const acknowledgments = (modSyncStatus as any).acknowledgments || []}
        
        {#if actualRemovals.length > 0}
          <button class="download-action-button required" on:click={downloadRequired}>
            🔄 Apply Mod Changes (Remove {actualRemovals.length} mod{actualRemovals.length > 1 ? 's' : ''})
          </button>
        {:else if acknowledgments.length > 0}
          <button class="download-action-button required" on:click={downloadRequired}>
            ✓ Acknowledge Dependencies ({acknowledgments.length})
          </button>
        {:else}
          <button class="download-action-button required" on:click={downloadRequired}>
            🔄 Synchronize Mods
          </button>
        {/if}
      {/if}
    {/if}
    
    {#if modSyncStatus && modSyncStatus.needsOptionalDownload && modSyncStatus.needsOptionalDownload > 0}
      <button class="download-action-button optional" on:click={downloadOptional}>
        📥 Download All Optional Mods ({modSyncStatus.needsOptionalDownload})
      </button>
      <div class="optional-mod-note">
        <span class="note-icon">💡</span>
        <span class="note-text">You can also download individual optional mods from the mods list below.</span>
      </div>
    {/if}
  </div>

  <!-- Last Sync Info -->
  {#if modSyncStatus}
    <div class="sync-info">
      <span class="sync-info-text">
        Last checked: {new Date().toLocaleTimeString()}
      </span>
      <button class="refresh-action-button" on:click={refresh}>
        🔄 Refresh Status
      </button>
    </div>
  {/if}
</div>

<style>
  .mod-status-overview {
    background-color: #1f2937;
    border-radius: 8px;
    border: 1px solid #374151;
    padding: 1.5rem;
    margin-bottom: 2rem;
  }

  .mod-status-overview h3 {
    color: white;
    margin: 0 0 1.5rem 0;
    font-size: 1.25rem;
  }

  .status-cards {
    display: grid;
    grid-template-columns: repeat(auto-fit, minmax(300px, 1fr));
    gap: 1rem;
    margin-bottom: 1.5rem;
  }

  .status-card {
    background-color: #374151;
    border-radius: 6px;
    border: 1px solid #4b5563;
    padding: 1rem;
    transition: border-color 0.2s;
  }

  .status-card.required {
    border-left: 4px solid #ef4444;
  }

  .status-card.optional {
    border-left: 4px solid #3b82f6;
  }

  .card-header {
    display: flex;
    align-items: center;
    gap: 0.5rem;
    margin-bottom: 1rem;
  }

  .card-icon {
    font-size: 1.25rem;
  }

  .card-title {
    color: white;
    font-weight: 600;
    font-size: 1rem;
  }

  .card-content {
    display: flex;
    flex-direction: column;
    gap: 0.5rem;
  }

  .mod-count {
    font-size: 2rem;
    font-weight: bold;
    color: white;
    line-height: 1;
  }

  .sync-status {
    margin: 0.5rem 0;
  }

  .status-text {
    font-size: 0.9rem;
    font-weight: 500;
  }

  .status-text.success {
    color: #10b981;
  }

  .status-text.warning {
    color: #f59e0b;
  }

  .status-text.info {
    color: #3b82f6;
  }

  .status-text.pending {
    color: #9ca3af;
  }
  .progress-info {
    font-size: 0.8rem;
    color: #9ca3af;
  }

  .overall-status {
    margin: 1.5rem 0;
    padding: 1rem;
    border-radius: 8px;
    border: 1px solid #374151;
  }
  .status-message {
    display: flex;
    align-items: flex-start;
    gap: 1rem;
    text-align: center;
  }

  .status-message.success {
    background-color: rgba(16, 185, 129, 0.1);
    border-color: #10b981;
  }

  .status-message.warning {
    background-color: rgba(245, 158, 11, 0.1);
    border-color: #f59e0b;
  }

  .status-message.info {
    background-color: rgba(59, 130, 246, 0.1);
    border-color: #3b82f6;
  }

  .status-icon {
    font-size: 1.5rem;
    flex-shrink: 0;
    margin-top: 0.25rem;
  }

  .status-content {
    flex: 1;
    text-align: center;
  }

  .status-content h4 {
    margin: 0 0 0.5rem 0;
    color: white;
    font-size: 1.1rem;
    font-weight: 600;
    text-align: center;
  }

  .status-content p {
    margin: 0;
    color: #d1d5db;
    font-size: 0.9rem;
    line-height: 1.4;
    text-align: center;
  }

  .action-buttons {
    display: flex;
    justify-content: center;
    gap: 1rem;
    margin-bottom: 1rem;
    flex-wrap: wrap;
  }

  .download-action-button {
    color: white;
    border: none;
    border-radius: 6px;
    padding: 0.75rem 1.5rem;
    font-weight: 600;
    cursor: pointer;
    transition: background-color 0.2s;
    min-width: 200px;
  }

  .download-action-button.required {
    background-color: #ef4444;
  }

  .download-action-button.required:hover {
    background-color: #dc2626;
  }

  .download-action-button.optional {
    background-color: #3b82f6;
  }
  .download-action-button.optional:hover {
    background-color: #2563eb;
  }

  .optional-mod-note {
    display: flex;
    align-items: center;
    gap: 0.5rem;
    margin-top: 0.75rem;
    padding: 0.75rem;
    background-color: rgba(59, 130, 246, 0.1);
    border: 1px solid rgba(59, 130, 246, 0.3);
    border-radius: 6px;
  }

  .note-icon {
    font-size: 1rem;
    flex-shrink: 0;
  }

  .note-text {
    font-size: 0.85rem;
    color: #d1d5db;
    line-height: 1.4;
  }

  .sync-info {
    display: flex;
    justify-content: space-between;
    align-items: center;
    padding-top: 1rem;
    border-top: 1px solid #4b5563;
  }

  .sync-info-text {
    font-size: 0.8rem;
    color: #9ca3af;
  }

  .refresh-action-button {
    background-color: #374151;
    color: white;
    border: none;
    border-radius: 4px;
    padding: 0.5rem 0.75rem;
    font-size: 0.8rem;
    cursor: pointer;
    transition: background-color 0.2s;
  }

  .refresh-action-button:hover {
    background-color: #4b5563;
  }
</style> 