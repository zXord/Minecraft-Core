<!-- @ts-ignore -->
<script>
  /// <reference path="../../electron.d.ts" />
  import { serverState } from '../../stores/serverState.js';
  import { validateServerPath } from '../../utils/folderUtils.js';
  import { safeInvoke } from '../../utils/ipcUtils.js';
  import ConfirmationDialog from '../../components/common/ConfirmationDialog.svelte';

  export let serverPath = '';
  
  // State for confirmation dialog
  let confirmDeleteVisible = false;
  // State for backup info dialog
  let backupDialogVisible = false;
  let backupTitle = '';
  let backupMessage = '';
  
  // Function to delete world folder
  async function deleteWorldFolder() {
    // Validate server path and check if server is running
    if (!validateServerPath(serverPath)) {
      return;
    }
    
    if ($serverState.status === 'Running') {
      return;
    }
    
    // Show confirmation dialog
    confirmDeleteVisible = true;
  }
  
  // Handle world deletion after confirmation
  async function confirmDeleteWorld() {
    // Close delete confirmation
    confirmDeleteVisible = false;
    try {
      const result = await safeInvoke('delete-world', serverPath);
      
      // Handle response
      if (!result) {
        backupTitle = 'Deletion Error';
        backupMessage = 'Error: No response received from delete operation';
      } else if (result.success) {
        backupTitle = 'World Deleted';
        backupMessage = `World deleted successfully.${result.backup ? `\n\nBackup created at:\n${result.backup}` : ''}`;
      } else if (result.error && result.error.includes('World folders not found')) {
        backupTitle = 'World Deletion';
        backupMessage = 'No world folders found. There is nothing to delete.';
      } else {
        backupTitle = 'Deletion Failed';
        backupMessage = `Failed to delete world: ${result.error || 'Unknown error'}`;
      }
    } catch (err) {
      backupTitle = 'Deletion Error';
      backupMessage = `Error deleting world: ${err && err.message ? err.message : 'Unknown error'}`;
    } finally {
      backupDialogVisible = true;
    }
  }
</script>

<div class="world-settings-section">
  <h3>World Settings</h3>
  
  <div class="section-content">
    <p>Manage your Minecraft world files</p>
    
    <div class="danger-zone">
      <h4>Danger Zone</h4>
      <p class="warning-text">These actions cannot be undone. Please be careful.</p>
      
      <button 
        class="delete-world-button" 
        on:click={deleteWorldFolder}
        disabled={$serverState.status === 'Running'}
        title={$serverState.status === 'Running' ? "Stop the server first" : "Delete world folder"}
      >
        🗑️ Delete World
      </button>
      
      {#if $serverState.status === 'Running'}
        <p class="server-running-warning">Stop the server before performing world operations</p>
      {/if}
    </div>
  </div>
</div>

<!-- Delete Confirmation Dialog -->
<ConfirmationDialog
  bind:visible={confirmDeleteVisible}
  title="Delete World"
  message="Are you sure you want to delete the world? This action cannot be undone."
  confirmText="Delete"
  cancelText="Cancel"
  confirmType="danger"
  backdropClosable={false}
  on:confirm={confirmDeleteWorld}
  on:cancel={() => confirmDeleteVisible = false}
/>

<!-- Backup Info Dialog -->
<ConfirmationDialog
  bind:visible={backupDialogVisible}
  title={backupTitle}
  message={backupMessage}
  confirmText="OK"
  cancelText=""
  showCancel={false}
  on:confirm={() => backupDialogVisible = false}
/>

<style>
  /* Remove ALL old styling - this component is now wrapped in cards */
  .world-settings-section {
    background: none !important;
    border: none !important;
    border-radius: 0 !important;
    padding: 0 !important;
    margin: 0 !important;
    box-shadow: none !important;
    max-width: none !important;
  }

  .world-settings-section h3 {
    display: none !important; /* Hide - title is in parent card */
  }
  
  .section-content {
    padding: 0 !important;
  }

  .section-content p {
    margin: 0 0 0.5rem 0 !important;
    font-size: 0.8rem !important;
    color: #9ca3af !important;
  }
  
  .danger-zone {
    background: rgba(239, 68, 68, 0.1) !important;
    border: 1px solid rgba(239, 68, 68, 0.3) !important;
    border-radius: 4px !important;
    padding: 0.5rem !important;
    margin: 0.5rem 0 0 0 !important;
  }
  
  .danger-zone h4 {
    color: #ef4444 !important;
    margin: 0 0 0.25rem 0 !important;
    font-size: 0.8rem !important;
  }
  
  .warning-text {
    color: #9ca3af !important;
    font-size: 0.75rem !important;
    margin: 0 0 0.5rem 0 !important;
  }
  
  .delete-world-button {
    background: rgba(239, 68, 68, 0.2) !important;
    border: 1px solid rgba(239, 68, 68, 0.4) !important;
    color: #ef4444 !important;
    border-radius: 4px !important;
    padding: 0.3rem 0.6rem !important;
    font-size: 0.75rem !important;
    cursor: pointer !important;
    width: 100% !important;
    margin-bottom: 0.25rem !important;
  }
  
  .delete-world-button:hover:not(:disabled) {
    background: rgba(239, 68, 68, 0.3) !important;
  }
  
  .delete-world-button:disabled {
    opacity: 0.5 !important;
    cursor: not-allowed !important;
  }
  
  .server-running-warning {
    color: #f59e0b !important;
    font-size: 0.7rem !important;
    text-align: center !important;
    margin: 0.25rem 0 0 0 !important;
  }
</style> 