<!-- @ts-ignore -->
<script>
  /// <reference path="../../electron.d.ts" />
  import { onMount } from 'svelte';
  
  export let serverPath = '';
  
  let autoRestartEnabled = false;
  let autoRestartDelay = 10; // seconds
  let maxCrashes = 3;
  let crashCount = 0;
  
  async function toggleAutoRestart() {
    const newState = !autoRestartEnabled;
    
    try {
      const result = await window.electron.invoke('set-auto-restart', {
        enabled: newState,
        delay: autoRestartDelay,
        maxCrashes: maxCrashes,
        targetPath: serverPath
      });
      
      // Update with server response
      autoRestartEnabled = result.enabled;
      autoRestartDelay = result.delay;
      maxCrashes = result.maxCrashes;
    } catch (err) {
      // Revert to original state on error
      autoRestartEnabled = !newState;
    }
  }
  
  async function updateAutoRestartSettings() {
    try {
      await window.electron.invoke('set-auto-restart', {
        enabled: autoRestartEnabled,
        delay: autoRestartDelay,
        maxCrashes: maxCrashes,
        targetPath: serverPath
      });
    } catch (err) {
      // Handle error silently in production
    }
  }
  
  onMount(() => {
    // Load initial auto-restart settings
    (async () => {
      try {
        // Get auto-restart settings from main process
        const autoRestartSettings = await window.electron.invoke('get-auto-restart');
        
        // Apply settings to component state
        autoRestartEnabled = autoRestartSettings.enabled;
        autoRestartDelay = autoRestartSettings.delay;
        maxCrashes = autoRestartSettings.maxCrashes;
        crashCount = autoRestartSettings.crashCount;
      } catch (err) {
        // Initialize with defaults if settings can't be loaded
        autoRestartEnabled = false;
        autoRestartDelay = 10;
        maxCrashes = 3;
        crashCount = 0;
      }
    })();
    
    // Listen for auto-restart status updates
    const statusHandler = (status) => {
      autoRestartEnabled = status.enabled;
      autoRestartDelay = status.delay;
      maxCrashes = status.maxCrashes;
      crashCount = status.crashCount;
    };
    
    window.electron.on('auto-restart-status', statusHandler);
    
    // Clean up event listeners when component is unmounted
    return () => {
      window.electron.removeListener('auto-restart-status', statusHandler);
    };
  });
</script>

<h3>Auto-Restart Settings</h3>
<div class="auto-restart-section">
  <label>
    <input 
      type="checkbox" 
      checked={autoRestartEnabled} 
      on:change={toggleAutoRestart} 
    />
    Auto-restart server on crash
  </label>
  
  <div class="restart-settings" class:disabled={!autoRestartEnabled}>
    <label>
      Restart delay (seconds):
      <input 
        type="number" 
        bind:value={autoRestartDelay} 
        on:change={updateAutoRestartSettings}
        min="5" 
        max="300" 
        disabled={!autoRestartEnabled}
      />
    </label>
    
    <label>
      Max crashes before disable:
      <input 
        type="number" 
        bind:value={maxCrashes} 
        on:change={updateAutoRestartSettings}
        min="1" 
        max="10" 
        disabled={!autoRestartEnabled}
      />
    </label>
    
    {#if crashCount > 0}
      <p class="warning">Server has crashed {crashCount} time(s) since last manual start</p>
    {/if}
  </div>
</div>

<style>
  /* Remove ALL old styling - this component is now wrapped in cards */
  h3 {
    display: none !important; /* Hide - title is in parent card */
  }

  .auto-restart-section {
    background: none !important;
    border: none !important;
    border-radius: 0 !important;
    padding: 0 !important;
    margin: 0 !important;
    box-shadow: none !important;
    max-width: none !important;
  }

  .auto-restart-section > label {
    display: flex !important;
    align-items: center !important;
    gap: 0.5rem !important;
    margin: 0 0 0.5rem 0 !important;
    font-weight: 500 !important;
    font-size: 0.8rem !important;
    color: #e2e8f0 !important;
    cursor: pointer !important;
  }

  .auto-restart-section > label input[type="checkbox"] {
    margin: 0 !important;
    accent-color: #3b82f6 !important;
  }

  .restart-settings {
    background: rgba(17, 24, 39, 0.4) !important;
    border: 1px solid rgba(75, 85, 99, 0.3) !important;
    border-radius: 4px !important;
    padding: 0.5rem !important;
    margin: 0.5rem 0 0 0 !important;
  }

  .restart-settings.disabled {
    opacity: 0.5 !important;
  }

  .restart-settings label {
    display: flex !important;
    justify-content: space-between !important;
    align-items: center !important;
    font-weight: normal !important;
    margin: 0 0 0.4rem 0 !important;
    font-size: 0.75rem !important;
    color: #9ca3af !important;
  }

  .restart-settings label:last-child {
    margin-bottom: 0 !important;
  }

  .restart-settings input[type="number"] {
    background: rgba(17, 24, 39, 0.6) !important;
    border: 1px solid rgba(75, 85, 99, 0.4) !important;
    color: #e2e8f0 !important;
    border-radius: 3px !important;
    padding: 0.2rem 0.4rem !important;
    font-size: 0.75rem !important;
    width: 60px !important;
  }

  .warning {
    color: #f59e0b !important;
    font-size: 0.7rem !important;
    margin: 0.5rem 0 0 0 !important;
    text-align: center !important;
  }
</style> 