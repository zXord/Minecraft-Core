<script>
  import { createEventDispatcher } from 'svelte';
  import { serverState } from '../../stores/serverState.js';
  import ConfirmationDialog from '../common/ConfirmationDialog.svelte';
  import logger from '../../utils/logger.js';
  
  export let instance;
  
  // State
  let deleteFiles = false;
  let showDeleteConfirmation = false;
  
  const dispatch = createEventDispatcher();

  function promptDelete() {
    logger.info('Prompting instance deletion confirmation', {
      category: 'ui',
      data: {
        component: 'InstanceSettings',
        function: 'promptDelete',
        instanceId: instance?.id,
        instanceName: instance?.name,
        instanceType: instance?.type,
        deleteFiles,
        serverRunning: $serverState.status === 'Running'
      }
    });
    
    showDeleteConfirmation = true;
  }

  async function confirmDelete() {
    logger.info('Confirming instance deletion', {
      category: 'ui',
      data: {
        component: 'InstanceSettings',
        function: 'confirmDelete',
        instanceId: instance?.id,
        instanceName: instance?.name,
        instanceType: instance?.type,
        deleteFiles,
        instancePath: instance?.path
      }
    });
    
    try {
      showDeleteConfirmation = false;
      
      const res = await window.electron.invoke('delete-instance', { 
        id: instance.id, 
        deleteFiles 
      });
      
      if (res.success) {
        logger.info('Instance deleted successfully', {
          category: 'ui',
          data: {
            component: 'InstanceSettings',
            function: 'confirmDelete',
            instanceId: instance.id,
            deleteFiles,
            hasWarning: !!res.warning
          }
        });
        
        if (res.warning) {
          logger.warn('Instance deletion completed with warning', {
            category: 'ui',
            data: {
              component: 'InstanceSettings',
              function: 'confirmDelete',
              warning: res.warning
            }
          });
          alert(res.warning);
        }
        dispatch('deleted', { id: instance.id });
      } else {
        logger.error('Instance deletion failed', {
          category: 'ui',
          data: {
            component: 'InstanceSettings',
            function: 'confirmDelete',
            instanceId: instance.id,
            error: res.error
          }
        });
        alert('Delete failed: ' + (res.error || 'Unknown error'));
      }
    } catch (err) {
      logger.error('Error during instance deletion', {
        category: 'ui',
        data: {
          component: 'InstanceSettings',
          function: 'confirmDelete',
          instanceId: instance.id,
          errorMessage: err.message
        }
      });
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
  /* Remove ALL old styling - this component is now wrapped in cards */
  .instance-settings-section {
    background: none !important;
    border: none !important;
    border-radius: 0 !important;
    padding: 0 !important;
    margin: 0 !important;
    box-shadow: none !important;
    max-width: none !important;
  }

  .instance-settings-section h3 {
    display: none !important; /* Hide - title is in parent card */
  }

  .section-content {
    padding: 0 !important;
  }

  .section-content > p {
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

  .delete-options {
    margin: 0 0 0.5rem 0 !important;
  }

  .delete-files-option {
    display: flex !important;
    align-items: center !important;
    gap: 0.4rem !important;
    user-select: none !important;
    cursor: pointer !important;
    font-size: 0.75rem !important;
    color: #e2e8f0 !important;
  }

  .delete-files-option input[type="checkbox"] {
    margin: 0 !important;
    accent-color: #ef4444 !important;
  }

  .delete-info {
    margin: 0.25rem 0 0 1.2rem !important;
    font-size: 0.7rem !important;
    color: #f59e0b !important;
  }

  .delete-instance-button {
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

  .delete-instance-button:hover:not(:disabled) {
    background: rgba(239, 68, 68, 0.3) !important;
  }

  .delete-instance-button:disabled {
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
