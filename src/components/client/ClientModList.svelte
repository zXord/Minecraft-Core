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
  }  interface ModSyncStatus {
    synchronized: boolean;
    missingMods?: string[];
    missingOptionalMods?: string[];
    needsOptionalDownload?: number;
    outdatedMods?: Array<{
      fileName: string;
      name: string;
      currentVersion: string;
      newVersion: string;
    }>;
    outdatedOptionalMods?: Array<{
      fileName: string;
      name: string;
      currentVersion: string;
      newVersion: string;
    }>;
    totalRequired?: number;
    totalOptional?: number;totalPresent?: number;
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
  
  // Section titles and descriptions
  const sectionInfo = {
    required: {
      title: 'Required Mods',
      description: 'These mods are required by the server and cannot be disabled.'
    },
    optional: {
      title: 'Optional Mods', 
      description: 'These mods are available but not required. You can enable or disable them before playing.'
    }
  };
  // Create event dispatcher
  const dispatch = createEventDispatcher();

  // Track which mods are currently being toggled
  let togglingMods: Set<string> = new Set();

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

    // Check if this mod is server-managed (use lowercase for comparison)
    const isServerManaged = serverManagedFiles.has(mod.fileName.toLowerCase());
    
    // Only show "server mod" status for required mods, not optional mods
    if (isServerManaged && type === 'required') {
      return 'server mod';
      }

    // For optional mods, check if disabled
    if (type === 'optional') {
      if (modSyncStatus.presentDisabledMods && modSyncStatus.presentDisabledMods.includes(mod.fileName)) {
        return 'disabled';
      }
    }
    
    return 'installed';
  }

  // Check if a mod needs to be removed
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

  // Get dependency acknowledgment info for a mod
  function getAcknowledgmentInfo(mod: Mod) {
    if (!modSyncStatus?.acknowledgments) return null;
    
    return modSyncStatus.acknowledgments.find(ack => 
      ack.fileName.toLowerCase() === mod.fileName.toLowerCase()
    );
  }

  // Handle mod toggle for optional mods
  function handleToggle(mod: Mod, enabled: boolean): void {
    if (type === 'required') return; // Required mods cannot be toggled

    // Mark this mod as being toggled
    togglingMods.add(mod.fileName);
    togglingMods = new Set(togglingMods); // Trigger reactivity

    // Dispatch to parent component for backend call
    dispatch('toggle', {
      fileName: mod.fileName,
      enabled: enabled
    });
  }

  // Function to handle toggle completion (called from parent)
  export function onToggleComplete(fileName: string) {
    togglingMods.delete(fileName);
    togglingMods = new Set(togglingMods); // Trigger reactivity
    
    // Update the local mod sync status to reflect the successful toggle
    if (modSyncStatus && type === 'optional') {
      const isCurrentlyDisabled = modSyncStatus.presentDisabledMods?.includes(fileName);
      
      if (isCurrentlyDisabled) {
        // Mod was disabled, now enabled - remove from disabled list
        modSyncStatus.presentDisabledMods = modSyncStatus.presentDisabledMods.filter(m => m !== fileName);
      } else {
        // Mod was enabled, now disabled - add to disabled list
        if (!modSyncStatus.presentDisabledMods) {
          modSyncStatus.presentDisabledMods = [];
        }
        modSyncStatus.presentDisabledMods.push(fileName);
      }
      
      // Trigger reactivity
      modSyncStatus = modSyncStatus;
  }
  }

  // Handle mod deletion
  function handleDelete(mod: Mod): void {
    dispatch('delete', { fileName: mod.fileName });
  }

  // Handle mod removal (for server-managed mods no longer required)
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

  // Check if a mod needs an update
  function needsUpdate(mod: Mod): boolean {
    if (!modSyncStatus) return false;
    
    // Check if this mod is in the outdated lists
    if (type === 'required' && modSyncStatus.outdatedMods) {
      return modSyncStatus.outdatedMods.some(update => 
        update.fileName?.toLowerCase() === mod.fileName.toLowerCase()
      );
    }
    
    if (type === 'optional' && modSyncStatus.outdatedOptionalMods) {
      return modSyncStatus.outdatedOptionalMods.some(update => 
        update.fileName?.toLowerCase() === mod.fileName.toLowerCase()
      );
    }
    
    return false;
  }

  // Get update information for a mod
  function getUpdateInfo(mod: Mod) {
    if (!modSyncStatus) return null;
    
    // Check if this mod is in the outdated lists
    if (type === 'required' && modSyncStatus.outdatedMods) {
      return modSyncStatus.outdatedMods.find(update => 
        update.fileName?.toLowerCase() === mod.fileName.toLowerCase()
      );
    }
    
    if (type === 'optional' && modSyncStatus.outdatedOptionalMods) {
      return modSyncStatus.outdatedOptionalMods.find(update => 
        update.fileName?.toLowerCase() === mod.fileName.toLowerCase()
      );
    }
    
    return null;
  }

  // Handle individual mod update
  function handleUpdate(mod: Mod): void {
    const updateInfo = getUpdateInfo(mod);
    if (!updateInfo) return;
    
    dispatch('updateMod', {
      fileName: updateInfo.fileName,
      name: updateInfo.name,
      currentVersion: updateInfo.currentVersion,
      newVersion: updateInfo.newVersion,
      mod: mod
    });
  }
</script>

<div class="client-mod-list">
  <!-- Integrated table with header -->
  <div class="table-container">
    <table class="client-mods-table" class:required-table={type === 'required'} class:optional-table={type === 'optional'}>
      <!-- Section header as first row -->
      <thead>
        <tr class="section-header {type}">
          <td colspan="5">
            <div class="section-header-content">
              <h3>{sectionInfo[type].title}</h3>
              <p class="section-description">{sectionInfo[type].description}</p>
              
              <!-- Optional mod download notification -->
              {#if type === 'optional' && modSyncStatus && ((modSyncStatus.missingOptionalMods && modSyncStatus.missingOptionalMods.length > 0) || (modSyncStatus.outdatedOptionalMods && modSyncStatus.outdatedOptionalMods.length > 0))}
                {@const totalOptionalWork = (modSyncStatus.missingOptionalMods?.length || 0) + (modSyncStatus.outdatedOptionalMods?.length || 0)}
                <div class="optional-notification">
                  <span class="notification-text">⚠️ {totalOptionalWork} optional mod{totalOptionalWork > 1 ? 's' : ''} {modSyncStatus.missingOptionalMods?.length > 0 ? 'available' : 'need updates'}</span>
                  <button class="notification-btn" on:click={handleDownload}>
                    📥 Download All Optional
                  </button>
                </div>
              {/if}
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
            {@const modStatus = getModStatus(mod)}
            <tr class:disabled={modStatus === 'disabled'}>
              
              <!-- Mod Name -->
              <td>
                                 <div class="mod-name-cell">
                   <strong>{mod.name || mod.fileName}</strong>
                 </div>
              </td>

              <!-- Status -->
              <td class="status">
                {#if needsRemoval(mod)}
                  <span class="tag warn">⚠️ Remove</span>
                {:else if needsAcknowledgment(mod)}
                  <span class="tag new">🔗 Acknowledge</span>
                {:else if modStatus === 'server mod'}
                  <span class="tag server">🔒 Server</span>
                {:else if modStatus === 'installed'}
                  <span class="tag ok">Enabled</span>
                {:else if modStatus === 'disabled'}
                  <span class="tag disabled">Disabled</span>
                {:else if modStatus === 'missing'}
                  <span class="tag missing">❌ Missing</span>
                {:else}
                  <span class="tag unknown">❓ Unknown</span>
                {/if}
              </td>

              <!-- Version -->
              <td class="ver">
                {#if mod.versionNumber}
                  <code>{mod.versionNumber}</code>
                {:else}
                  <span class="no-version">—</span>
                {/if}
              </td>

              <!-- Update -->
              <td class="upd">
                {#if needsUpdate(mod)}
                  {@const updateInfo = getUpdateInfo(mod)}
                  <button class="tag new clickable" 
                          on:click={() => handleUpdate(mod)}
                          title="Update to {updateInfo?.newVersion}">
                    ↑ {updateInfo?.newVersion}
                  </button>
                {:else}
                  <span class="tag ok">Up to date</span>
                {/if}
              </td>

              <!-- Actions -->
              <td class="act">
                {#if type === 'required'}
                  {#if needsAcknowledgment(mod)}
                    <button class="primary sm" on:click={() => handleAcknowledge(mod)} title="Acknowledge dependency">
                      ✓ Ack
                    </button>
                  {:else if needsRemoval(mod)}
                    <button class="danger sm" on:click={() => handleRemove(mod)} title="Remove mod">
                      🗑️ Remove
                    </button>
                  {:else if modStatus === 'missing'}
                    <button class="primary sm" on:click={handleDownload}>
                      📥 Download
                    </button>
                  {:else}
                    <span class="required-tag">Required</span>
                  {/if}
                {:else if type === 'optional'}
                  {#if needsAcknowledgment(mod)}
                    <button class="primary sm" on:click={() => handleAcknowledge(mod)} title="Acknowledge dependency">
                      ✓ Ack
                    </button>
                  {:else if needsRemoval(mod)}
                    <button class="danger sm" on:click={() => handleRemove(mod)} title="Remove mod">
                      🗑️ Remove
                    </button>
                  {:else if modStatus === 'missing'}
                    <button class="primary sm" on:click={() => handleDownloadSingle(mod)}>
                      📥 Download
                    </button>
                  {:else}
                    <div class="action-group">
                      {#if togglingMods.has(mod.fileName)}
                        <button class="toggle sm loading" disabled title="Processing...">
                          ⏳ Loading...
                        </button>
                      {:else}
                      <button class="toggle sm" 
                              class:primary={modStatus === 'disabled'}
                              class:warn={modStatus === 'installed'}
                              on:click={() => handleToggle(mod, modStatus !== 'installed')}
                              title={modStatus === 'installed' ? 'Disable mod' : 'Enable mod'}>
                        {modStatus === 'installed' ? 'Disable' : 'Enable'}
                      </button>
                      {/if}
                      {#if modStatus !== 'missing'}
                        <button class="danger sm" on:click={() => handleDelete(mod)} title="Remove mod">
                          🗑️
                        </button>
                      {/if}
                    </div>
                  {/if}
                {/if}
              </td>
            </tr>

            <!-- Dependency notification row -->
            {#if needsAcknowledgment(mod)}
              {@const acknowledgmentInfo = getAcknowledgmentInfo(mod)}
              <tr class="dependency-row">
                <td colspan="5">
                  <div class="dependency-info">
                    <span class="dependency-reason">🔗 {acknowledgmentInfo?.reason || 'required as dependency'}</span>
                  </div>
                </td>
              </tr>
            {/if}
          {/each}
        </tbody>
        
        <!-- Empty state as table row -->
        {#if mods.length === 0}
          <tbody>
            <tr class="empty-state">
              <td colspan="5">
                <p>No {type} mods found.</p>
              </td>
            </tr>
          </tbody>
        {/if}
      </table>
    </div>
    
    <!-- Summary for missing mods -->
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
</div>

<style>
  /* CSS variables and color tokens */
  .client-mod-list {
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
  }

  .client-mod-list {
    width: 100%;
  }

  /* Section header as table row */
  .section-header td {
    background-color: #1f2937;
    border-top: 3px solid #3b82f6; /* Default blue */
    padding: 0.75rem var(--cell-px) !important;
  }

  .section-header.required td {
    border-top-color: #ef4444; /* Red for required */
  }

  .section-header.optional td {
    border-top-color: #f59e0b; /* Orange for optional */
  }

  .section-header-content {
    text-align: center;
  }

  .section-header h3 {
    color: white;
    margin: 0 0 0.15rem 0;
    font-size: 1rem;
    font-weight: 600;
  }

  .section-header .section-description {
    color: #9ca3af;
    font-size: 0.8rem;
    margin: 0;
    line-height: 1.3;
  }

  /* Optional notification within section header */
  .optional-notification {
    display: flex;
    justify-content: space-between;
    align-items: center;
    padding: 0.4rem 0.6rem;
    background-color: rgba(59, 130, 246, 0.1);
    border: 1px solid rgba(59, 130, 246, 0.3);
    border-radius: 4px;
    margin-top: 0.4rem;
    gap: 0.75rem;
  }

  .notification-text {
    font-size: 0.8rem;
    color: #3b82f6;
    font-weight: 500;
  }

  .notification-btn {
    padding: 0.3rem 0.6rem;
    border: none;
    border-radius: 4px;
    font-size: 0.75rem;
    font-weight: 500;
    cursor: pointer;
    transition: background-color 0.2s;
    background-color: #3b82f6;
    color: white;
    white-space: nowrap;
  }

  .notification-btn:hover {
    background-color: #2563eb;
  }

  .empty-state {
    text-align: center;
    padding: 2rem;
    color: #9ca3af;
    font-style: italic;
    background-color: #1f2937;
    border: 1px solid #374151;
    border-top: none;
    border-radius: 0 0 6px 6px;
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

    /* Column widths */
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

  .tag.warn {
    background: rgba(200, 128, 31, 0.2);
    color: var(--col-warn);
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

  .tag.missing {
    background: rgba(179, 51, 51, 0.2);
    color: var(--col-danger);
  }

  .tag.unknown {
    background: rgba(156, 163, 175, 0.2);
    color: #9ca3af;
  }

  .tag.clickable {
    cursor: pointer;
    transition: all 0.2s;
  }

  .tag.clickable:hover {
    opacity: 0.8;
    transform: translateY(-1px);
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

  .required-tag {
    font-size: 0.75rem;
    color: var(--col-danger);
    font-weight: 500;
    text-align: center;
  }

  /* Dependency notification row */
  .dependency-row {
    background: rgba(16, 185, 129, 0.05) !important;
  }

  .dependency-info {
    padding: 4px 8px;
    font-size: 0.75rem;
  }

  .dependency-reason {
    color: #10b981;
    font-style: italic;
  }

  /* Summary sections */
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

  .download-all-button {
    background-color: #3b82f6;
    color: white;
    border: none;
    border-radius: 4px;
    padding: 0.4rem 0.75rem;
    font-size: 0.75rem;
    cursor: pointer;
    transition: background-color 0.2s;
  }

  .download-all-button:hover {
    background-color: #2563eb;
  }

  .download-all-button.optional {
    background-color: #3b82f6;
  }

  .download-all-button.optional:hover {
    background-color: #2563eb;
  }
</style>