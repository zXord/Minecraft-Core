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
  /* Auto-restart styling */
  .auto-restart-section {
    max-width: 500px;
    margin: 0 auto 1.5rem;
    padding: 1rem;
    border: 1px solid #ffffff;
    border-radius: 8px;
    background: #272727;
  }
  
  .auto-restart-section label {
    display: block;
    margin-bottom: 0.5rem;
    font-weight: bold;
  }
  
  .auto-restart-section .restart-settings {
    margin: 1rem 0;
    padding: 1rem;
    border-top: 1px solid #e0e0e0;
  }
  
  .auto-restart-section .restart-settings.disabled {
    opacity: 0.6;
  }
  
  .auto-restart-section .restart-settings label {
    display: flex;
    justify-content: space-between;
    align-items: center;
    font-weight: normal;
    margin-bottom: 0.75rem;
  }
  
  .auto-restart-section .restart-settings input {
    width: 80px;
    padding: 0.3rem;
  }
  
  .warning {
    color: orange;
  }
</style> 