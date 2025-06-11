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
  .world-settings-section {
    max-width: 500px;
    margin: 1.5rem auto;
    padding: 1rem;
    border: 1px solid #ffffff;
    border-radius: 8px;
    background: #272727;
  }
  
  h3 {
    margin-top: 0;
    margin-bottom: 1rem;
    text-align: center;
  }
  
  .section-content {
    text-align: left;
  }
  
  .danger-zone {
    margin-top: 1.5rem;
    padding: 1rem;
    border: 1px solid #ff5555;
    border-radius: 6px;
    background: rgba(255, 0, 0, 0.1);
  }
  
  .danger-zone h4 {
    color: #ff5555;
    margin-top: 0;
    margin-bottom: 0.5rem;
  }
  
  .warning-text {
    color: rgba(255, 255, 255, 0.7);
    font-size: 0.9rem;
    margin-bottom: 1rem;
  }
  
  .delete-world-button {
    background: rgba(255, 0, 0, 0.2);
    border: 1px solid rgba(255, 0, 0, 0.3);
    border-radius: 4px;
    padding: 0.5rem 1rem;
    cursor: pointer;
    font-size: 0.9rem;
    transition: all 0.2s ease;
    color: white;
    display: block;
    width: 100%;
    text-align: center;
    margin-bottom: 0.5rem;
  }
  
  .delete-world-button:hover:not(:disabled) {
    background: rgba(255, 0, 0, 0.3);
  }
  
  .delete-world-button:disabled {
    opacity: 0.5;
    cursor: not-allowed;
  }
  
  .server-running-warning {
    color: #ff9800;
    font-size: 0.8rem;
    text-align: center;
    margin-top: 0.5rem;
  }
</style> 