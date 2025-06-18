<script>
  import { createEventDispatcher } from 'svelte';
  import ConfirmationDialog from '../common/ConfirmationDialog.svelte';
  
  export let show = false;
  /** @type {any} */
  export let compatibilityReport = null;
  export let newMinecraftVersion = '';
  export let oldMinecraftVersion = '';
  
  const dispatch = createEventDispatcher();
  
  let showDetails = false;
  
  function handleContinue() {
    show = false;
    dispatch('continue');
  }
  
  function handleUpdateMods() {
    show = false;
    dispatch('update-mods', { modsToUpdate: compatibilityReport?.needsUpdate || [] });
  }
  
  function handleDisableIncompatible() {
    show = false;
    dispatch('disable-incompatible', { modsToDisable: compatibilityReport?.incompatible || [] });
  }
    $: incompatibleCount = compatibilityReport?.incompatible?.length || 0;
  $: needsUpdateCount = compatibilityReport?.needsUpdate?.length || 0;
  $: unknownCount = compatibilityReport?.unknown?.length || 0;
  $: totalIssues = incompatibleCount + needsUpdateCount + unknownCount;
  
  // Debug logging to trace the data
  $: if (compatibilityReport) {
    console.log('🔍 [COMPATIBILITY DIALOG] Full report:', compatibilityReport);
    console.log('🔍 [COMPATIBILITY DIALOG] Compatible mods:', compatibilityReport.compatible);
    console.log('🔍 [COMPATIBILITY DIALOG] Incompatible mods:', compatibilityReport.incompatible);
    console.log('🔍 [COMPATIBILITY DIALOG] Needs update mods:', compatibilityReport.needsUpdate);
    console.log('🔍 [COMPATIBILITY DIALOG] Unknown mods:', compatibilityReport.unknown);
  }
</script>

{#if show && compatibilityReport}
  <ConfirmationDialog
    title="Client-Side Mod Compatibility Warning"
    message=""
    confirmText="Continue Anyway"
    cancelText="Review Mods"
    showCancel={true}
    on:confirm={handleContinue}
    on:cancel={() => showDetails = true}
  >
    <div class="compatibility-warning">
      <div class="warning-header">
        <h3>Minecraft Version Change Detected</h3>
        <p>Changing from <strong>{oldMinecraftVersion}</strong> to <strong>{newMinecraftVersion}</strong></p>
      </div>
      
      <div class="issue-summary">
        <p>Found <strong>{totalIssues}</strong> potential compatibility issues with your client-side mods:</p>
        
        {#if compatibilityReport.incompatible && compatibilityReport.incompatible.length > 0}
          <div class="issue-group incompatible">
            <span class="issue-count">{compatibilityReport.incompatible.length}</span>
            <span class="issue-label">Incompatible mods</span>
          </div>
        {/if}
        
        {#if compatibilityReport.needsUpdate && compatibilityReport.needsUpdate.length > 0}
          <div class="issue-group needs-update">
            <span class="issue-count">{compatibilityReport.needsUpdate.length}</span>
            <span class="issue-label">Mods with available updates</span>
          </div>
        {/if}
        
        {#if compatibilityReport.unknown && compatibilityReport.unknown.length > 0}
          <div class="issue-group unknown">
            <span class="issue-count">{compatibilityReport.unknown.length}</span>
            <span class="issue-label">Mods with unknown compatibility</span>
          </div>
        {/if}
      </div>
      
      <div class="recommendations">
        <h4>Recommendations:</h4>
        <ul>
          {#if compatibilityReport.needsUpdate && compatibilityReport.needsUpdate.length > 0}
            <li>Update {compatibilityReport.needsUpdate.length} mod{compatibilityReport.needsUpdate.length > 1 ? 's' : ''} to compatible versions</li>
          {/if}
          {#if compatibilityReport.incompatible && compatibilityReport.incompatible.length > 0}
            <li>Disable {compatibilityReport.incompatible.length} incompatible mod{compatibilityReport.incompatible.length > 1 ? 's' : ''} temporarily</li>
          {/if}
          {#if compatibilityReport.unknown && compatibilityReport.unknown.length > 0}
            <li>Manually verify {compatibilityReport.unknown.length} mod{compatibilityReport.unknown.length > 1 ? 's' : ''} with unknown compatibility</li>
          {/if}
        </ul>
      </div>
      
      <div class="action-buttons">
        {#if compatibilityReport.needsUpdate && compatibilityReport.needsUpdate.length > 0}
          <button class="btn btn-primary" on:click={handleUpdateMods}>
            Update Available Mods
          </button>
        {/if}
        
        {#if compatibilityReport.incompatible && compatibilityReport.incompatible.length > 0}
          <button class="btn btn-warning" on:click={handleDisableIncompatible}>
            Disable Incompatible Mods
          </button>
        {/if}
        
        <button class="btn btn-link" on:click={() => showDetails = true}>
          View Details
        </button>
      </div>
    </div>
  </ConfirmationDialog>
{/if}

{#if showDetails && compatibilityReport}
  <div
    class="modal-overlay"
    role="button"
    tabindex="0"
    aria-label="Close details"
    on:click={() => showDetails = false}
    on:keydown={(e) => { if (e.key === 'Enter' || e.key === ' ' || e.key === 'Escape') showDetails = false; }}
  >
    <div
      class="modal-content details-modal"
      role="dialog"
      aria-modal="true"
      aria-labelledby="modDetailsTitle"
      tabindex="0"
      on:click|stopPropagation
      on:keydown|stopPropagation
    >
      <div class="modal-header">
        <h3 id="modDetailsTitle">Mod Compatibility Details</h3>
        <button class="close-btn" on:click={() => showDetails = false} aria-label="Close details">&times;</button>
      </div>
      
      <div class="modal-body">
        {#if compatibilityReport.compatible && compatibilityReport.compatible.length > 0}
          <div class="mod-category compatible">
            <h4>✅ Compatible Mods ({compatibilityReport.compatible.length})</h4>
            <div class="mod-list">
              {#each compatibilityReport.compatible as mod (mod.name)}
                <div class="mod-item">
                  <span class="mod-name">{mod.name}</span>
                  <span class="mod-reason">{mod.reason || 'Compatible with ' + newMinecraftVersion}</span>
                </div>
              {/each}
            </div>
          </div>
        {/if}
        
        {#if compatibilityReport.needsUpdate && compatibilityReport.needsUpdate.length > 0}
          <div class="mod-category needs-update">
            <h4>🔄 Mods with Available Updates ({compatibilityReport.needsUpdate.length})</h4>
            <div class="mod-list">
              {#each compatibilityReport.needsUpdate as mod (mod.name)}
                <div class="mod-item">
                  <span class="mod-name">{mod.name}</span>
                  <span class="mod-reason">{mod.reason}</span>
                  {#if mod.availableUpdate}
                    <span class="update-info">Update to v{mod.availableUpdate.version}</span>
                  {/if}
                </div>
              {/each}
            </div>
          </div>
        {/if}
        
        {#if compatibilityReport.incompatible && compatibilityReport.incompatible.length > 0}
          <div class="mod-category incompatible">
            <h4>❌ Incompatible Mods ({compatibilityReport.incompatible.length})</h4>
            <div class="mod-list">
              {#each compatibilityReport.incompatible as mod (mod.name)}
                <div class="mod-item">
                  <span class="mod-name">{mod.name}</span>
                  <span class="mod-reason">{mod.reason}</span>
                </div>
              {/each}
            </div>
          </div>
        {/if}
        
        {#if compatibilityReport.unknown && compatibilityReport.unknown.length > 0}
          <div class="mod-category unknown">
            <h4>❓ Unknown Compatibility ({compatibilityReport.unknown.length})</h4>
            <div class="mod-list">
              {#each compatibilityReport.unknown as mod (mod.name)}
                <div class="mod-item">
                  <span class="mod-name">{mod.name}</span>
                  <span class="mod-reason">{mod.reason}</span>
                </div>
              {/each}
            </div>
          </div>
        {/if}
        
        {#if compatibilityReport.errors && compatibilityReport.errors.length > 0}
          <div class="mod-category errors">
            <h4>⚠️ Errors ({compatibilityReport.errors.length})</h4>
            <div class="mod-list">
              {#each compatibilityReport.errors as mod (mod.name)}
                <div class="mod-item">
                  <span class="mod-name">{mod.name}</span>
                  <span class="mod-reason error">{mod.reason}</span>
                </div>
              {/each}
            </div>
          </div>
        {/if}
      </div>
      
      <div class="modal-footer">
        <button class="btn btn-secondary" on:click={() => showDetails = false}>Close</button>
        <button class="btn btn-primary" on:click={handleContinue}>Continue Anyway</button>
      </div>
    </div>
  </div>
{/if}

<style>
  .compatibility-warning {
    max-width: 500px;
    padding: 20px;
  }
  
  .warning-header h3 {
    margin: 0 0 10px 0;
    color: #ff9800;
  }
  
  .warning-header p {
    margin: 0 0 20px 0;
    color: #666;
  }
  
  .issue-summary {
    margin-bottom: 20px;
  }
  
  .issue-group {
    display: flex;
    align-items: center;
    margin: 8px 0;
    padding: 8px 12px;
    border-radius: 4px;
    background: rgba(0, 0, 0, 0.05);
  }
  
  .issue-group.incompatible {
    background: rgba(244, 67, 54, 0.1);
    border-left: 4px solid #f44336;
  }
  
  .issue-group.needs-update {
    background: rgba(255, 152, 0, 0.1);
    border-left: 4px solid #ff9800;
  }
  
  .issue-group.unknown {
    background: rgba(158, 158, 158, 0.1);
    border-left: 4px solid #9e9e9e;
  }
  
  .issue-count {
    font-weight: bold;
    font-size: 1.2em;
    margin-right: 10px;
    min-width: 24px;
    text-align: center;
  }
  
  .issue-label {
    color: #333;
  }
  
  .recommendations {
    margin-bottom: 20px;
  }
  
  .recommendations h4 {
    margin: 0 0 10px 0;
    color: #333;
  }
  
  .recommendations ul {
    margin: 0;
    padding-left: 20px;
  }
  
  .recommendations li {
    margin: 5px 0;
    color: #666;
  }
  
  .action-buttons {
    display: flex;
    gap: 10px;
    flex-wrap: wrap;
  }
  
  .btn {
    padding: 8px 16px;
    border: none;
    border-radius: 4px;
    cursor: pointer;
    font-size: 14px;
    transition: background-color 0.2s;
  }
  
  .btn-primary {
    background: #2196f3;
    color: white;
  }
  
  .btn-primary:hover {
    background: #1976d2;
  }
  
  .btn-warning {
    background: #ff9800;
    color: white;
  }
  
  .btn-warning:hover {
    background: #f57c00;
  }
  
  .btn-link {
    background: transparent;
    color: #2196f3;
    text-decoration: underline;
  }
  
  .btn-link:hover {
    color: #1976d2;
  }
  
  .btn-secondary {
    background: #6c757d;
    color: white;
  }
  
  .btn-secondary:hover {
    background: #545b62;
  }
  
  /* Details Modal Styles */
  .modal-overlay {
    position: fixed;
    top: 0;
    left: 0;
    width: 100%;
    height: 100%;
    background: rgba(0, 0, 0, 0.5);
    display: flex;
    align-items: center;
    justify-content: center;
    z-index: 1000;
  }
  
  .modal-content {
    background: white; /* Adjust as per your theme */
    color: #333; /* Adjust as per your theme */
    padding: 20px;
    border-radius: 8px;
    box-shadow: 0 4px 15px rgba(0, 0, 0, 0.2);
    max-height: 80vh;
    overflow-y: auto;
    position: relative; /* For close button positioning */
  }

  .details-modal {
    min-width: 500px; /* Or your preferred width */
    max-width: 700px; /* Or your preferred max-width */
  }
  
  .modal-header {
    display: flex;
    justify-content: space-between;
    align-items: center;
    border-bottom: 1px solid #eee; /* Adjust as per your theme */
    padding-bottom: 10px;
    margin-bottom: 15px;
  }
  
  .modal-header h3 {
    margin: 0;
    font-size: 1.25em;
  }
  
  .close-btn {
    background: none;
    border: none;
    font-size: 1.5em;
    cursor: pointer;
    padding: 0 5px;
    color: #888; /* Adjust as per your theme */
  }
  .close-btn:hover {
    color: #333; /* Adjust as per your theme */
  }
  
  .modal-body {
    margin-bottom: 15px;
  }
  
  .mod-category {
    margin-bottom: 20px;
  }
  
  .mod-category h4 {
    margin-top: 0;
    margin-bottom: 10px;
    font-size: 1.1em;
    border-bottom: 1px solid #f0f0f0; /* Adjust as per your theme */
    padding-bottom: 5px;
  }
  
  .mod-category.compatible h4 { color: #4CAF50; } /* Green */
  .mod-category.needs-update h4 { color: #FF9800; } /* Orange */
  .mod-category.incompatible h4 { color: #F44336; } /* Red */
  .mod-category.unknown h4 { color: #757575; } /* Grey */
  .mod-category.errors h4 { color: #D32F2F; } /* Darker Red */

  .mod-list {
    max-height: 200px; /* Example height, adjust as needed */
    overflow-y: auto;
    padding-right: 10px; /* For scrollbar */
  }
  
  .mod-item {
    display: flex;
    justify-content: space-between;
    padding: 8px 0;
    border-bottom: 1px solid #f5f5f5; /* Adjust as per your theme */
    font-size: 0.9em;
  }
  .mod-item:last-child {
    border-bottom: none;
  }
  
  .mod-name {
    font-weight: bold;
    margin-right: 10px;
  }
  
  .mod-reason {
    color: #555; /* Adjust as per your theme */
    text-align: right;
  }
  
  .mod-reason.error {
    color: #c00; /* Error reason color */
    font-weight: bold;
  }

  .update-info {
    font-size: 0.85em;
    color: #007bff; /* Blue, or your primary action color */
    margin-left: 10px;
  }
  
  .modal-footer {
    display: flex;
    justify-content: flex-end;
    padding-top: 15px;
    border-top: 1px solid #eee; /* Adjust as per your theme */
  }
  
  .modal-footer .btn {
    margin-left: 10px;
  }

  /* Ensure buttons from parent context are styled if not already global */
  .btn {
    padding: 8px 15px;
    border-radius: 4px;
    cursor: pointer;
    font-size: 0.9em;
    text-decoration: none;
    display: inline-block;
    text-align: center;
    border: 1px solid transparent;
  }
  .btn-primary {
    background-color: #007bff; /* Example color */
    color: white;
    border-color: #007bff;
  }
  .btn-primary:hover {
    background-color: #0056b3;
  }
  .btn-warning {
    background-color: #ffc107; /* Example color */
    color: #212529;
    border-color: #ffc107;
  }
  .btn-warning:hover {
    background-color: #e0a800;
  }
  .btn-secondary {
    background-color: #6c757d; /* Example color */
    color: white;
    border-color: #6c757d;
  }
  .btn-secondary:hover {
    background-color: #545b62;
  }
  .btn-link {
    background: none;
    border: none;
    color: #007bff; /* Example color */
    text-decoration: underline;
  }
  .btn-link:hover {
    color: #0056b3;
  }
</style>
