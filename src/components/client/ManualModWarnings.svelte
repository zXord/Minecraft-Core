<!-- ManualModWarnings.svelte - Component to show warnings about manual mods -->
<script lang="ts">
  import { onMount } from 'svelte';
  import { safeInvoke } from '../../utils/ipcUtils.js';

  export let clientPath: string = '';

  interface ManualModInfo {
    manualMods: string[];
    lastUpdated: string;
    warning: string;
  }

  let manualModInfo: ManualModInfo | null = null;
  let showWarning = false;

  onMount(async () => {
    await loadManualModInfo();
  });  async function loadManualModInfo() {
    try {
      if (!clientPath) return;
      
      try {
        const response = await safeInvoke('check-manual-mods', { clientPath, minecraftVersion: '1.20.1' });        if (response && response.success) {
          // Convert the response structure to match what the component expects
          manualModInfo = {
            manualMods: response.results || [],
            lastUpdated: new Date().toISOString(),
            warning: response.results && response.results.length > 0 
              ? 'Some manual mods may need checking for compatibility.' 
              : 'No compatibility issues found.'
          };
          showWarning = manualModInfo && manualModInfo.manualMods.length > 0;        }
      } catch {
        // Fallback: Try to read the file directly if IPC handler isn't available yet
        try {
          const configContent = await safeInvoke('read-file', `${clientPath}/manual-mods.json`);
          if (configContent) {
            manualModInfo = JSON.parse(configContent);
            showWarning = manualModInfo && manualModInfo.manualMods && manualModInfo.manualMods.length > 0;
          }
        } catch {
        }
      }
    } catch {
    }
  }

  function dismissWarning() {
    showWarning = false;
  }  async function removeIncompatibleMods() {
    try {
      await safeInvoke('remove-manual-mods', clientPath);
      await loadManualModInfo();
    } catch {
    }
  }
</script>

{#if showWarning && manualModInfo}
  <div class="warning-banner" role="alert">
    <div class="warning-header">
      <div class="warning-icon">⚠️</div>
      <div class="warning-title">Manual Mods Detected</div>
      <button class="dismiss-btn" on:click={dismissWarning} aria-label="Dismiss warning">×</button>
    </div>
    
    <div class="warning-content">
      <p class="warning-message">{manualModInfo.warning}</p>
      
      <div class="manual-mods-list">
        <h4>Manual Mods Found ({manualModInfo.manualMods.length}):</h4>
        <ul>
          {#each manualModInfo.manualMods as mod}
            <li>{mod}</li>
          {/each}
        </ul>
      </div>

      <div class="warning-actions">
        <button class="btn btn-secondary" on:click={dismissWarning}>
          Keep & Continue
        </button>
        <button class="btn btn-warning" on:click={removeIncompatibleMods}>
          Remove All Manual Mods
        </button>
      </div>
    </div>
  </div>
{/if}

<style>
  .warning-banner {
    background: linear-gradient(135deg, #fff3cd 0%, #ffeaa7 100%);
    border: 2px solid #ffc107;
    border-radius: 8px;
    margin: 16px 0;
    overflow: hidden;
    box-shadow: 0 2px 8px rgba(255, 193, 7, 0.2);
  }

  .warning-header {
    display: flex;
    align-items: center;
    padding: 12px 16px;
    background: rgba(255, 193, 7, 0.1);
    border-bottom: 1px solid #ffc107;
  }

  .warning-icon {
    font-size: 20px;
    margin-right: 8px;
  }

  .warning-title {
    font-weight: 600;
    font-size: 16px;
    color: #856404;
    flex: 1;
  }

  .dismiss-btn {
    background: none;
    border: none;
    font-size: 20px;
    color: #856404;
    cursor: pointer;
    padding: 0;
    width: 24px;
    height: 24px;
    display: flex;
    align-items: center;
    justify-content: center;
    border-radius: 4px;
    transition: background-color 0.2s;
  }

  .dismiss-btn:hover {
    background: rgba(133, 100, 4, 0.1);
  }

  .warning-content {
    padding: 16px;
  }

  .warning-message {
    color: #856404;
    margin: 0 0 16px 0;
    line-height: 1.5;
  }

  .manual-mods-list {
    margin: 16px 0;
  }

  .manual-mods-list h4 {
    color: #856404;
    margin: 0 0 8px 0;
    font-size: 14px;
    font-weight: 600;
  }

  .manual-mods-list ul {
    list-style: none;
    padding: 0;
    margin: 0;
    max-height: 120px;
    overflow-y: auto;
    background: rgba(255, 255, 255, 0.5);
    border-radius: 4px;
    padding: 8px;
  }

  .manual-mods-list li {
    padding: 4px 8px;
    font-family: 'Fira Code', 'Courier New', monospace;
    font-size: 13px;
    color: #495057;
    border-bottom: 1px solid rgba(133, 100, 4, 0.1);
  }

  .manual-mods-list li:last-child {
    border-bottom: none;
  }

  .warning-actions {
    display: flex;
    gap: 12px;
    margin-top: 16px;
    justify-content: flex-end;
  }

  .btn {
    padding: 8px 16px;
    border: none;
    border-radius: 6px;
    font-size: 14px;
    font-weight: 500;
    cursor: pointer;
    transition: all 0.2s;
    text-decoration: none;
    display: inline-flex;
    align-items: center;
    justify-content: center;
  }

  .btn-secondary {
    background: #6c757d;
    color: white;
  }

  .btn-secondary:hover {
    background: #5a6268;
  }

  .btn-warning {
    background: #dc3545;
    color: white;
  }

  .btn-warning:hover {
    background: #c82333;
  }

  /* Dark mode support */
  :global(.dark) .warning-banner {
    background: linear-gradient(135deg, #2d2011 0%, #3d2a17 100%);
    border-color: #ffc107;
  }

  :global(.dark) .warning-header {
    background: rgba(255, 193, 7, 0.05);
  }

  :global(.dark) .warning-title,
  :global(.dark) .warning-message,
  :global(.dark) .manual-mods-list h4 {
    color: #ffc107;
  }

  :global(.dark) .dismiss-btn {
    color: #ffc107;
  }

  :global(.dark) .dismiss-btn:hover {
    background: rgba(255, 193, 7, 0.1);
  }

  :global(.dark) .manual-mods-list ul {
    background: rgba(0, 0, 0, 0.3);
  }

  :global(.dark) .manual-mods-list li {
    color: #ced4da;
    border-bottom-color: rgba(255, 193, 7, 0.1);
  }
</style>
