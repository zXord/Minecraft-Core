<!-- @ts-ignore -->
<script>
  /// <reference path="../../electron.d.ts" />
  import { onMount } from 'svelte';
  import { serverState } from '../../stores/serverState.js';
  
  export let serverPath = '';
  
  // Health & repair state
  let healthReport = [];
  let repairing = false;
  let repairProgress = 0;
  let repairSpeed = '0 MB/s';
  let repairLogs = [];
  
  // Minecraft version info for repairs
  let selectedMC;
  let selectedFabric;
  
  // Java installation check
  let javaInstalled = null;
  
  async function checkHealth() {
    try {
      healthReport = (await window.electron.invoke('check-health', serverPath)) || [];
      console.log('Health report:', healthReport);
    } catch (err) {
      console.error('Health check error:', err);
      healthReport = [];
    }
  }

  async function checkJava() {
    try {
      const result = await window.electron.invoke('check-java');
      javaInstalled = result.installed;
      return result.installed;
    } catch (err) {
      console.error('Java check error:', err);
      javaInstalled = false;
      return false;
    }
  }

  async function startRepair() {
    try {
      console.log('Repair button clicked');
      
      // Skip Java check for now and go directly to repair process
      repairing = true;
      repairLogs = ['Starting repair process...'];
      repairProgress = 0;
      
      // Load repair listeners
      setupRepairListeners();
      
      if (!selectedMC || !selectedFabric) {
        // Try to get version info from config
        console.log('Missing version info, loading from config');
        repairLogs = [...repairLogs, 'Looking for server configuration...'];
        
        try {
          const config = await window.electron.invoke('read-config', serverPath);
          console.log('Config loaded:', config);
          
          if (config && config.version) {
            selectedMC = config.version;
            selectedFabric = config.fabric || 'latest';
            console.log('Using version info from config:', { selectedMC, selectedFabric });
            repairLogs = [...repairLogs, `Found Minecraft version: ${selectedMC}`];
            repairLogs = [...repairLogs, `Found Fabric version: ${selectedFabric}`];
          } else {
            repairLogs = [...repairLogs, 'Error: Missing version information in server configuration.'];
            throw new Error('Missing version information. Please configure server settings first.');
          }
        } catch (configErr) {
          console.error('Config error:', configErr);
          repairLogs = [...repairLogs, `Error: ${configErr.message || 'Failed to load server configuration'}`];
          throw configErr;
        }
      }
      
      console.log('Starting repair with:', {
        targetPath: serverPath,
        mcVersion: selectedMC,
        fabricVersion: selectedFabric
      });
      
      repairLogs = [...repairLogs, `Repairing server with Minecraft ${selectedMC} and Fabric ${selectedFabric}`];

      // Direct call to repair-health without delay
      try {
        console.log('Directly calling repair-health handler');
        repairLogs = [...repairLogs, 'Sending repair request to server...'];
        
        const result = await window.electron.invoke('repair-health', {
          targetPath: serverPath,
          mcVersion: selectedMC,
          fabricVersion: selectedFabric
        });
        
        console.log('Repair completed with result:', result);
      } catch (repairErr) {
        console.error('Repair error from main process:', repairErr);
        repairLogs = [...repairLogs, `Error from server: ${repairErr.message || 'Unknown error during repair'}`];
        repairing = false;
      }
    } catch (err) {
      console.error('Repair error:', err);
      repairLogs = [...repairLogs, `Error: ${err.message || 'Unknown error during repair'}`];
      repairing = false;
    }
  }
  
  function setupRepairListeners() {
    // Remove any existing listeners first to prevent duplicates
    window.electron.removeAllListeners('repair-progress');
    window.electron.removeAllListeners('repair-log');
    window.electron.removeAllListeners('repair-status');
    
    window.electron.on('repair-progress', (data) => {
      console.log('Repair progress:', data);
      if (data && typeof data.percent === 'number') {
        repairProgress = data.percent;
        repairSpeed = data.speed || '0.00 MB/s';
      }
    });
    
    window.electron.on('repair-log', msg => {
      console.log('Repair log:', msg);
      repairLogs = [...repairLogs, msg];
    });
    
    window.electron.on('repair-status', status => {
      console.log('Repair status:', status);
      if (status === 'done') {
        repairProgress = 100;
        setTimeout(() => {
          repairing = false;
          checkHealth();
        }, 1000);
      }
    });
  }
  
  onMount(() => {
    // Run async initialization code
    (async () => {
      try {
        // Initialize repair event listeners right away
        console.log('Setting up repair listeners on mount');
        setupRepairListeners();

        // Load configuration to get versions
        const config = await window.electron.invoke('read-config', serverPath);
        if (config) {
          selectedMC = config.version;
          selectedFabric = config.fabric || 'latest';
          console.log('Loaded config versions:', { selectedMC, selectedFabric });
        }
        
        // Initial health check
        await checkHealth();
      } catch (error) {
        console.error('Init error:', error);
      }
    })();
    
    // Clean up event listeners when component is unmounted
    return () => {
      window.electron.removeAllListeners('repair-progress');
      window.electron.removeAllListeners('repair-log');
      window.electron.removeAllListeners('repair-status');
    };
  });
</script>

<div class="server-repair-section">
  <h3>Server Core Files</h3>
  <p class="description">This tool checks and repairs essential server files only (not world data or mods).</p>

  <button class="check-button" on:click={checkHealth}>
    Check Core Files
  </button>

  {#if healthReport.length}
    <div class="status-panel warning">
      <h4>Missing Core Files Detected</h4>
      <ul class="file-list">
        {#each healthReport as f}
          <li class="missing-file">⚠️ Missing: {f}</li>
        {/each}
      </ul>
      
      <div class="repair-info">
        <p>The repair will download these essential server files:</p>
        <ul class="file-list">
          {#each healthReport as f}
            <li class="repair-file">↻ {f}</li>
          {/each}
        </ul>
      </div>
      
      <button class="repair-button" on:click={() => {
        console.log('Repair button clicked directly in SVG');
        startRepair();
      }} disabled={repairing}>
        {repairing ? 'Repairing...' : 'Repair Server Core'}
      </button>
      
      {#if repairing}
        <div class="progress-container">
          <div class="progress-info">
            <span class="progress-percentage">{repairProgress}%</span>
            <span class="progress-speed">Speed: {repairSpeed}</span>
          </div>
          <progress max="100" value={repairProgress}></progress>
        </div>
        
        <div class="repair-logs">
          {#each repairLogs as l}
            <div class="log-line">{l}</div>
          {/each}
        </div>
      {/if}
    </div>
  {:else}
    <div class="status-panel success">
      <p>✅ All server core files are present and ready.</p>
    </div>
  {/if}
</div>

<style>
  .server-repair-section {
    background-color: #272727;
    border-radius: 8px;
    padding: 1.5rem;
    margin-bottom: 2rem;
    box-shadow: 0 2px 4px rgba(0, 0, 0, 0.2);
    text-align: left;
    max-width: 800px;
    margin-left: auto;
    margin-right: auto;
  }
  
  h3 {
    font-size: 1.4rem;
    margin-top: 0;
    margin-bottom: 0.5rem;
    color: #ffffff;
  }
  
  h4 {
    font-size: 1.1rem;
    margin-top: 1rem;
    margin-bottom: 0.5rem;
    color: #ffcc00;
  }
  
  .description {
    color: #aaaaaa;
    margin-bottom: 1.5rem;
  }
  
  .status-panel {
    padding: 1rem;
    border-radius: 6px;
    margin-top: 1rem;
  }
  
  .status-panel.warning {
    background-color: rgba(255, 180, 0, 0.1);
    border: 1px solid rgba(255, 180, 0, 0.3);
  }
  
  .status-panel.success {
    background-color: rgba(76, 175, 80, 0.1);
    border: 1px solid rgba(76, 175, 80, 0.3);
  }
  
  .check-button, .repair-button {
    padding: 0.6rem 1.2rem;
    font-weight: bold;
    border: none;
    border-radius: 4px;
    cursor: pointer;
    transition: background-color 0.2s;
    font-size: 0.9rem;
  }
  
  .check-button {
    background-color: #4a6da7;
    color: white;
  }
  
  .check-button:hover {
    background-color: #5a7db7;
  }
  
  .repair-button {
    background-color: #f44336;
    color: white;
    margin-top: 1rem;
  }
  
  .repair-button:hover {
    background-color: #e53935;
  }
  
  button:disabled {
    background-color: #555555;
    cursor: not-allowed;
    opacity: 0.7;
  }
  
  .file-list {
    list-style: none;
    padding: 0.5rem;
    margin: 0.5rem 0;
    font-family: monospace;
  }
  
  .missing-file {
    color: #f44336;
    margin-bottom: 0.3rem;
  }
  
  .repair-file {
    color: #4caf50;
    margin-bottom: 0.3rem;
  }
  
  .repair-info {
    margin: 1rem 0;
    padding: 0.5rem;
    background-color: rgba(0, 0, 0, 0.2);
    border-radius: 4px;
  }
  
  .progress-container {
    margin: 1rem 0;
  }
  
  .progress-info {
    display: flex;
    justify-content: space-between;
    margin-bottom: 0.5rem;
  }
  
  .progress-percentage {
    font-weight: bold;
    color: #4caf50;
  }
  
  .progress-speed {
    color: #aaaaaa;
  }
  
  progress {
    width: 100%;
    height: 12px;
    appearance: none;
    border: none;
    border-radius: 6px;
    overflow: hidden;
    background-color: #1a1a1a;
  }
  
  /* Progress bar styling */
  progress::-webkit-progress-bar {
    background-color: #1a1a1a;
    border-radius: 6px;
  }
  
  progress::-webkit-progress-value {
    background-color: #4caf50;
    border-radius: 6px;
  }
  
  progress::-moz-progress-bar {
    background-color: #4caf50;
    border-radius: 6px;
  }
  
  .repair-logs {
    margin-top: 1rem;
    max-height: 200px;
    overflow-y: auto;
    padding: 0.5rem;
    background-color: #1a1a1a;
    border: 1px solid #333333;
    border-radius: 4px;
    font-family: monospace;
    font-size: 0.85rem;
    color: #dddddd;
  }
  
  .log-line {
    padding: 0.2rem 0;
    border-bottom: 1px solid #333333;
  }
  
  .log-line:last-child {
    border-bottom: none;
  }
</style>
