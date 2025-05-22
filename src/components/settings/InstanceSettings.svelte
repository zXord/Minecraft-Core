<script>
  import { createEventDispatcher } from 'svelte';
  import { serverState } from '../../stores/serverState.js';
  import ConfirmationDialog from '../common/ConfirmationDialog.svelte';
  
  export let instance;
  
  // State
  let deleteFiles = false;
  let showDeleteConfirmation = false;
  
  const dispatch = createEventDispatcher();

  function promptDelete() {
    showDeleteConfirmation = true;
  }

  async function confirmDelete() {
    try {
      showDeleteConfirmation = false;
      
      const res = await window.electron.invoke('delete-instance', { 
        id: instance.id, 
        deleteFiles 
      });
      
      if (res.success) {
        if (res.warning) {
          alert(res.warning);
        }
        dispatch('deleted', { id: instance.id });
      } else {
        alert('Delete failed: ' + (res.error || 'Unknown error'));
      }
    } catch (err) {
      alert('Error deleting instance: ' + (err.message || 'Unknown error'));
    }
  }
</script>

<div class="instance-settings-section">
  <h3>Instance Management</h3>
  
  <div class="section-content">
    <p>Manage your Minecraft instance settings</p>
    
    <div class="danger-zone">
      <h4>Danger Zone</h4>
      <p class="warning-text">These actions cannot be undone. Please be careful.</p>
      
      {#if instance.type === 'server'}
        <div class="delete-options">
          <label class="delete-files-option">
            <input type="checkbox" bind:checked={deleteFiles} />
            <span>Delete all server files ({instance.path})</span>
          </label>
          <p class="delete-info">If checked, the entire server folder will be permanently deleted.</p>
        </div>
      {/if}
      
      <button 
        class="delete-instance-button" 
        on:click={promptDelete}
        disabled={$serverState.status === 'Running' && instance.type === 'server'}
        title={$serverState.status === 'Running' && instance.type === 'server' ? 
          "Stop the server first" : "Delete this instance"}
      >
        🗑️ Delete Instance
      </button>
      
      {#if $serverState.status === 'Running' && instance.type === 'server'}
        <p class="server-running-warning">Stop the server before deleting the instance</p>
      {/if}
    </div>
  </div>
</div>

<!-- Delete Confirmation Dialog -->
<ConfirmationDialog
  bind:visible={showDeleteConfirmation}
  title="Delete Instance"
  message={deleteFiles ? 
    `Are you sure you want to delete the instance "${instance.name}" and ALL SERVER FILES? This action cannot be undone.` : 
    `Are you sure you want to delete the instance "${instance.name}"? The server files will remain on disk.`}
  confirmText="Delete"
  cancelText="Cancel"
  confirmType="danger"
  backdropClosable={false}
  on:confirm={confirmDelete}
  on:cancel={() => showDeleteConfirmation = false}
/>

<style>
  .instance-settings-section {
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
  
  .delete-instance-button {
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
  
  .delete-instance-button:hover:not(:disabled) {
    background: rgba(255, 0, 0, 0.3);
  }
  
  .delete-instance-button:disabled {
    opacity: 0.5;
    cursor: not-allowed;
  }
  
  .server-running-warning {
    color: #ff9800;
    font-size: 0.8rem;
    text-align: center;
    margin-top: 0.5rem;
  }
  
  .delete-options {
    margin-bottom: 1rem;
  }
  
  .delete-files-option {
    display: flex;
    align-items: center;
    gap: 0.5rem;
    user-select: none;
    cursor: pointer;
  }
  
  .delete-info {
    margin-top: 0.25rem;
    font-size: 0.8rem;
    color: #ff9800;
    margin-left: 1.5rem;
  }
</style>
