<!-- @ts-ignore -->
<script>
  /// <reference path="../../electron.d.ts" />
  import { onMount } from 'svelte';
  import { serverState } from '../../stores/serverState.js';
  import { playerState } from '../../stores/playerState.js';
  
  // Reactive variables from stores
  $: cpuLoad = $serverState.cpuLoad;
  $: memUsedMB = $serverState.memUsedMB;
  $: maxRamMB = $serverState.maxRamMB;
  $: uptime = $serverState.uptime;
  $: players = $playerState.count;  
  $: isServerRunning = $serverState.status === 'Running';
    
  // Calculate memory percentage with safety checks
  $: memPercentage = (() => {
    if (!isServerRunning) return 0;
    if (!maxRamMB || maxRamMB <= 0) return 0;
    
    // Handle potential zero or invalid values
    const usedMem = Math.max(0, memUsedMB || 0);
    const maxMem = Math.max(1, maxRamMB || 1); // Avoid division by zero
    
    // Calculate percentage with bounds
    return Math.min(Math.max(Number(((usedMem/maxMem)*100).toFixed(1)), 0), 100);
  })();

  // Reset metrics when server stops
  $: if (!isServerRunning && $serverState.cpuLoad !== 0) {
    serverState.update(state => ({
      ...state,
      cpuLoad: 0,
      memUsedMB: 0,
      uptime: '0h 0m 0s'
    }));
  }
  
  // Add mount/unmount handling to make sure we refresh our state
  onMount(() => {
    // Add a listener specifically for server status changes
    const statusHandler = (status) => {
      if (status !== 'running') {
        // Force reset metrics when server stops
        serverState.update(state => ({
          ...state,
          status: 'Stopped',
          cpuLoad: 0,
          memUsedMB: 0,
          uptime: '0h 0m 0s'
        }));
      }
    };
    
    // Listen for status updates
    window.electron.on('server-status', statusHandler);
    
    // Cleanup
    return () => {
      window.electron.removeListener('server-status', statusHandler);
    };
  });
</script>

<div class="metrics-container">
  <div class="metric-card">
    <h3>CPU Usage</h3>
    <div class="metric-value">
      {#if isServerRunning}
        {#if typeof cpuLoad === 'number' && !isNaN(cpuLoad)}
          {cpuLoad.toFixed(1)}%
        {:else}
          <span class="calculating">Calculating...</span>
        {/if}
      {:else}
        <span class="not-running">—</span>
      {/if}
    </div>
    <div class="progress-bar">
      <div class="progress-fill" style="width: {isServerRunning && typeof cpuLoad === 'number' && !isNaN(cpuLoad) ? cpuLoad : 0}%"></div>
    </div>
  </div>
  
  <div class="metric-card">
    <h3>Memory Usage</h3>
    <div class="metric-value">
      {#if isServerRunning}
        {#if memUsedMB > 0 && maxRamMB > 0}
          {Math.round(memUsedMB)} MB / {Math.round(maxRamMB)} MB ({memPercentage}%)
        {:else}
          <span class="calculating">Calculating...</span>
        {/if}
      {:else}
        <span class="not-running">—</span>
      {/if}
    </div>
    <div class="progress-bar">
      <div class="progress-fill" style="width: {memPercentage}%"></div>
    </div>
  </div>
  
  <div class="metric-card">
    <h3>Server Uptime</h3>
    <div class="metric-value">
      {#if isServerRunning}
        {uptime}
      {:else}
        <span class="not-running">—</span>
      {/if}
    </div>
  </div>
  
  <div class="metric-card">
    <h3>Players Online</h3>
    <div class="metric-value">
      {#if isServerRunning}
        {players}
      {:else}
        <span class="not-running">—</span>
      {/if}
    </div>
  </div>
</div>

<style>
  .metrics-container {
    display: grid;
    grid-template-columns: repeat(4, 1fr); /* Force 4 columns always */
    gap: 1rem;
    margin: 1rem auto;
    width: 100%;
    max-width: 1200px;
    box-sizing: border-box;
  }
  
  /* For very small screens, keep the 4 columns but make them smaller */
  @media (max-width: 768px) {
    .metrics-container {
      gap: 0.5rem;
    }
    
    .metric-card {
      padding: 0.5rem;
      min-width: 0; /* Allow cards to shrink */
    }
    
    .metric-card h3 {
      font-size: 0.8rem;
    }
    
    .metric-value {
      font-size: 1.1rem;
    }
  }
  
  .metric-card {
    background-color: #2b2b2b;
    border-radius: 8px;
    padding: 1rem;
    text-align: center;
    box-shadow: 0 2px 4px rgba(0, 0, 0, 0.1);
  }
  
  .metric-card h3 {
    margin: 0 0 0.5rem 0;
    font-size: 1rem;
    color: #cccccc;
  }
  
  .metric-value {
    font-size: 1.5rem;
    font-weight: bold;
    margin-bottom: 0.5rem;
  }
  
  .not-running {
    color: #888;
    font-style: italic;
  }
  
  .calculating {
    color: #f0a030;
    font-style: italic;
    font-size: 1.2rem;
  }
  
  .progress-bar {
    height: 10px;
    background-color: #3a3a3a;
    border-radius: 5px;
    overflow: hidden;
  }
  
  .progress-fill {
    height: 100%;
    background-color: #4caf50;
    transition: width 0.3s ease;
  }
  
  /* Change color based on usage */
  .progress-fill:global(.warning) {
    background-color: #ffaa00;
  }
  
  .progress-fill:global(.critical) {
    background-color: #ff4444;
  }
</style>
