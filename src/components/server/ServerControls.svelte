<!-- @ts-ignore -->
<script lang="ts">  /// <reference path="../../electron.d.ts" />
  import { onMount, onDestroy } from 'svelte';
  import { get } from 'svelte/store';
  import { serverState, updateServerMetrics, updateServerStatus } from '../../stores/serverState.js';
  import { playerState, updateOnlinePlayers, showContextMenu } from '../../stores/playerState.js';
  import PlayerContextMenu from '../players/PlayerContextMenu.svelte';  import { openFolder, validateServerPath } from '../../utils/folderUtils.js';
  import { errorMessage } from '../../stores/modStore.js';
  import { settingsStore, loadSettings } from '../../stores/settingsStore.js';
  import { latestVersions, refreshLatestVersions } from '../../stores/versionUpdates.js';
  
  // Import compareVersions function for semantic version comparison
  function compareVersions(versionA, versionB) {
    if (!versionA || !versionB) return 0;
    if (versionA === versionB) return 0;
    
    // Convert to arrays of version components
    const partsA = versionA.split(/[.-]/).map(part => {
      const num = parseInt(part, 10);
      return isNaN(num) ? part : num;
    });
    
    const partsB = versionB.split(/[.-]/).map(part => {
      const num = parseInt(part, 10);
      return isNaN(num) ? part : num;
    });
    
    // Compare each part
    const minLength = Math.min(partsA.length, partsB.length);
    
    for (let i = 0; i < minLength; i++) {
      const a = partsA[i];
      const b = partsB[i];
      
      // If both are numbers, compare numerically
      if (typeof a === 'number' && typeof b === 'number') {
        if (a !== b) return a - b;
      } 
      // If both are strings, compare alphabetically
      else if (typeof a === 'string' && typeof b === 'string') {
        if (a !== b) return a.localeCompare(b);
      }
      // Numbers are considered greater than strings for this purpose
      else if (typeof a === 'number') {
        return 1;
      } else {
        return -1;
      }
    }
    
    // If we get here, one version might be a prefix of the other
    // The longer one is considered newer (e.g., 1.0.1 > 1.0)
    return partsA.length - partsB.length;
  }
  
  export let serverPath = '';
  
  // Initialize local variables and store subscriptions
  let port = 25565;
  let maxRam = 4;
  $: status = $serverState.status;
  $: isServerRunning = status === 'Running';
  $: playerNames = $playerState.onlinePlayers;

  let statusCheckInterval: NodeJS.Timeout;
  let isVisible = true;
  // Access global serverPath when local prop is empty
  $: {
    if (!serverPath && window.serverPath) {
      serverPath = window.serverPath.get();
    }
  }

  // Reactive config loading when server path changes
  $: {
    if (serverPath) {
      loadServerConfig(serverPath);
    }
  }
  async function loadServerConfig(path) {
    try {
      const configResult = await window.electron.invoke('read-config', path);
      
      if (configResult && (configResult.version || configResult.fabric)) {
        loadSettings(configResult);
      } else {
      }
    } catch (error) {
    }
  }

  // Server status tracking
  $: serverStatus = $serverState?.status || 'stopped';
  $: port = $serverState?.port || 25565;
  $: maxRam = $serverState?.maxRam || 4;

  // Management server state
  let managementServerStatus = 'stopped'; // stopped, starting, running, stopping
  let managementPort = 8080;
  let connectedClients = 0;
  
  // Auto-start settings
  let autoStartMinecraft = false;
  let autoStartManagement = false;  // Version update tracking
  $: currentMcVersion = $settingsStore.mcVersion;
  $: currentFabricVersion = $settingsStore.fabricVersion;
  $: latestMcVersion = $latestVersions.mc;
  $: latestFabricVersion = $latestVersions.fabric;
  $: mcUpdateAvailable = currentMcVersion && latestMcVersion && compareVersions(latestMcVersion, currentMcVersion) > 0;
  $: fabricUpdateAvailable = currentFabricVersion && latestFabricVersion && compareVersions(latestFabricVersion, currentFabricVersion) > 0;

  // Debug logging for version changes
  $: if (currentMcVersion !== undefined) {
  }
  $: if (currentFabricVersion !== undefined) {
  }

  let updateChecked = false;
  $: upToDate = updateChecked && !mcUpdateAvailable && !fabricUpdateAvailable && latestMcVersion && latestFabricVersion;
  async function checkVersionUpdates() {
    
    await refreshLatestVersions(currentMcVersion);
    
    
    if (currentMcVersion && latestMcVersion) {
      const mcComparison = compareVersions(latestMcVersion, currentMcVersion);
    }
    
    if (currentFabricVersion && latestFabricVersion) {
      const fabricComparison = compareVersions(latestFabricVersion, currentFabricVersion);
    }
    
    updateChecked = true;
  }
  
  // Helper function to enable input fields
  function enableInputFields() {
    const portInput = document.getElementById('port-input');
    const ramInput = document.getElementById('ram-input');
    const portLabel = document.getElementById('port-label');
    const ramLabel = document.getElementById('ram-label');
    
    if (portInput instanceof HTMLInputElement) {
      portInput.disabled = false;
      portInput.classList.remove('disabled-input');
    }
    if (ramInput instanceof HTMLInputElement) {
      ramInput.disabled = false;
      ramInput.classList.remove('disabled-input');
    }
    if (portLabel) portLabel.classList.remove('disabled');
    if (ramLabel) ramLabel.classList.remove('disabled');
  }

  // Helper function to disable input fields
  function disableInputFields() {
    const portInput = document.getElementById('port-input');
    const ramInput = document.getElementById('ram-input');
    const portLabel = document.getElementById('port-label');
    const ramLabel = document.getElementById('ram-label');
    
    if (portInput instanceof HTMLInputElement) {
      portInput.disabled = true;
      portInput.classList.add('disabled-input');
    }
    if (ramInput instanceof HTMLInputElement) {
      ramInput.disabled = true;
      ramInput.classList.add('disabled-input');
    }
    if (portLabel) portLabel.classList.add('disabled');
    if (ramLabel) ramLabel.classList.add('disabled');
  }

  // Update input states based on server status
  $: {
    if (isServerRunning) {
      disableInputFields();
    } else {
      enableInputFields();
    }
  }

  // Function to check server status
  async function checkServerStatus() {
    try {
      const statusResult = await window.electron.invoke('get-server-status');
      if (statusResult) {
        const normalizedStatus = statusResult.status === 'running' ? 'Running' : 'Stopped';
        serverState.update(state => ({
          ...state,
          status: normalizedStatus
        }));
        
        if (normalizedStatus === 'Running' && statusResult.playersInfo?.names) {
          updateOnlinePlayers(statusResult.playersInfo.names);
        } else if (normalizedStatus === 'Stopped') {
          updateOnlinePlayers([]);
        }
      }
    } catch (err) {
      // Failed to check status, assume stopped
      serverState.update(state => ({
        ...state,
        status: 'Stopped'
      }));
      updateOnlinePlayers([]);
    }
  }

  // Function to check management server status and update client count
  async function checkManagementServerStatus() {
    if (managementServerStatus === 'running') {
      try {
        const result = await window.electron.invoke('get-management-server-status');
        if (result.success && result.status) {
          // Update client count
          connectedClients = result.status.clientCount || 0;
        }
      } catch (error) {
      }
    }
  }

  function startServer() { 
    // Optimistic update: mark server as running immediately
    updateServerStatus('Running');
    window.electron.invoke('start-server', { 
      targetPath: serverPath, 
      port: port, 
      maxRam: maxRam 
    }); 
  }

  function stopServer() { 
    window.electron.invoke('stop-server')
      .then(() => {
        // Force-enable inputs after the stop command is sent
        setTimeout(enableInputFields, 100);
        setTimeout(enableInputFields, 500);
      });
  }

  function killServer() { 
    window.electron.invoke('kill-server')
      .then(() => {
        // Force-enable inputs after the kill command is sent
        setTimeout(enableInputFields, 100);
        setTimeout(enableInputFields, 500);
      });
  }

  let statusHandler: (status: any) => void;
  let metricsHandler: (metrics: any) => void;

  // Handle visibility change
  function handleVisibilityChange() {
    isVisible = document.visibilityState === 'visible';
    if (isVisible) {
      // When tab becomes visible, check server status
      checkServerStatus();
    }
  }

  onMount(() => {
    // Set up visibility change listener
    document.addEventListener('visibilitychange', handleVisibilityChange);

    // Set up periodic status check
    statusCheckInterval = setInterval(() => {
      if (isVisible) {
        checkServerStatus();
        checkManagementServerStatus();
      }
    }, 5000); // Check every 5 seconds when visible

    // Load settings first, then check server status
    (async () => {
      try {
        // Load saved settings
        const settingsResult = await window.electron.invoke('get-settings');
        if (settingsResult && settingsResult.success) {
          const { settings } = settingsResult;
          // Update local variables with settings
          if (settings.port) port = settings.port;
          if (settings.maxRam) maxRam = settings.maxRam;
          if (settings.autoStartMinecraft !== undefined) autoStartMinecraft = settings.autoStartMinecraft;
          if (settings.autoStartManagement !== undefined) autoStartManagement = settings.autoStartManagement;
          // Update server state store
          serverState.update(state => ({
            ...state,
            port,
            maxRam          }));        }
        // Initial status check
        await checkServerStatus();

        // Fetch latest version info for update notification
        await refreshLatestVersions(get(settingsStore).mcVersion);
        updateChecked = true;
        
        // Load management server status on mount
        try {
          const result = await window.electron.invoke('get-management-server-status');
          if (result.success && result.status) {
            managementServerStatus = result.status.isRunning ? 'running' : 'stopped';
            managementPort = result.status.port || 8080;
            connectedClients = result.status.clientCount || 0;
          }
        } catch (error) {
        }
        
        // Handle auto-start servers if enabled
        await handleAutoStart();
      } catch (err) {
        // Failed to get settings or server status
      }
    })();

    // Set up a server status listener
    statusHandler = (status) => {
      // Convert status string to proper format ('running' → 'Running', everything else → 'Stopped')
      const normalizedStatus = typeof status === 'string' 
          ? (status === 'running' ? 'Running' : 'Stopped')
          : (status?.status === 'running' ? 'Running' : 'Stopped');
      // Update store
      serverState.update(state => ({
        ...state,
        status: normalizedStatus
      }));
      // If server stopped, empty the player list and enable inputs
      if (normalizedStatus === 'Stopped') {
        // Reset player list
        updateOnlinePlayers([]);
        // Force enable port and RAM inputs when server stops
        enableInputFields();
        // And after small delays to ensure UI catches up
        setTimeout(enableInputFields, 100);
        setTimeout(enableInputFields, 500);
      }
    };

    // Listen for metrics updates
    metricsHandler = (metrics) => {
      // Update the server state store
      updateServerMetrics(metrics);
      // Update player information
      updateOnlinePlayers(metrics.names || []);
    };

    window.electron.on('server-status', statusHandler);
    window.electron.on('metrics-update', metricsHandler);

    // Listen for management server status updates
    const handleManagementServerStatus = (data) => {
      if (data.isRunning) {
        managementServerStatus = 'running';
        managementPort = data.port || 8080;
      } else {
        managementServerStatus = 'stopped';
        connectedClients = 0;
      }
    };
    
    window.electron.on('management-server-status', handleManagementServerStatus);
    
    return () => {
      window.electron.removeAllListeners('management-server-status');
    };
  });

  onDestroy(() => {
    // Clean up event listeners and intervals
    document.removeEventListener('visibilitychange', handleVisibilityChange);
    if (statusCheckInterval) {
      clearInterval(statusCheckInterval);
    }
    if (statusHandler) {
      window.electron.removeListener('server-status', statusHandler);
    }
    if (metricsHandler) {
      window.electron.removeListener('metrics-update', metricsHandler);
    }
  });

  // Update server state when port or ram is changed
  function updateSettings() {
    // Update local state
    serverState.update(state => ({
      ...state,
      port: port,
      maxRam: maxRam
    }));
    // Save settings to electron store
    window.electron.invoke('update-settings', {
      port: port,
      maxRam: maxRam,
      autoStartMinecraft: autoStartMinecraft,
      autoStartManagement: autoStartManagement
    }).catch(err => {
      // Failed to save settings - silent fail
    });
  }
  
  // Handle auto-start functionality
  async function handleAutoStart() {
    if (!validateServerPath(serverPath)) {
      return;
    }
    
    // Auto-start management server first if enabled
    if (autoStartManagement && managementServerStatus === 'stopped') {
      try {
        await startManagementServer();
      } catch (error) {
      }
    }
    
    // Auto-start Minecraft server if enabled
    if (autoStartMinecraft && status === 'Stopped') {
      try {
        startServer();
      } catch (error) {
      }
    }
  }

  // Open server folder in explorer
  async function openFolderInExplorer() {
    if (!validateServerPath(serverPath)) return;
    
    // Add a debounce flag to the window to prevent multiple opens
    if (window._folderOpenInProgress) {
      return;
    }
    
    window._folderOpenInProgress = true;
    
    try {
      await openFolder(serverPath);
    } finally {
      // Reset the flag after a short delay
      setTimeout(() => {
        window._folderOpenInProgress = false;
      }, 1000);
    }
  }

  // Show context menu for player
  function showPlayerContextMenu(event, playerName) {
    event.preventDefault();
    showContextMenu(event.clientX, event.clientY, playerName);
  }
  
  // Management server functions
  async function startManagementServer() {
    if (!validateServerPath(serverPath)) return;
    
    managementServerStatus = 'starting';
    try {
      const result = await window.electron.invoke('start-management-server', {
        port: managementPort,
        serverPath: serverPath
      });
      
      if (result.success) {
        managementServerStatus = 'running';
      } else {
        managementServerStatus = 'stopped';
        errorMessage.set(`Failed to start management server: ${result.error}`);
        setTimeout(() => errorMessage.set(''), 5000);
      }
    } catch (error) {
      managementServerStatus = 'stopped';
      errorMessage.set(`Error starting management server: ${error.message}`);
      setTimeout(() => errorMessage.set(''), 5000);
    }
  }

  async function stopManagementServer() {
    managementServerStatus = 'stopping';
    try {
      const result = await window.electron.invoke('stop-management-server');
      
      if (result.success) {
        managementServerStatus = 'stopped';
        connectedClients = 0;
      } else {
        managementServerStatus = 'running';
        errorMessage.set(`Failed to stop management server: ${result.error}`);
        setTimeout(() => errorMessage.set(''), 5000);
      }
    } catch (error) {
      managementServerStatus = 'running';
      errorMessage.set(`Error stopping management server: ${error.message}`);
      setTimeout(() => errorMessage.set(''), 5000);
    }
  }
</script>  

<div class="server-controls">
  <div class="status-section">
    <h3>Minecraft Server Control Panel</h3>
    <div class="update-section">
      <button class="check-updates-button" on:click={checkVersionUpdates}>Check Updates</button>
      {#if mcUpdateAvailable || fabricUpdateAvailable}
        <div class="update-notice">
          {#if mcUpdateAvailable}
            <span>Minecraft {currentMcVersion} → {latestMcVersion}</span>
          {/if}
          {#if fabricUpdateAvailable}
            <span>Fabric {currentFabricVersion} → {latestFabricVersion}</span>
          {/if}
        </div>
      {:else if upToDate}
        <div class="update-notice up-to-date">All versions are up to date.</div>
      {/if}
    </div>
    <div class="status-display">
      <span class="status-label">Minecraft Server Status:</span>
      <span class="status-value" class:status-running={status === 'Running'} class:status-stopped={status !== 'Running'}>
        {status}
      </span>
    </div>
    
    <div class="settings" class:has-running-server={isServerRunning}>
      <div class="setting-item">
        <label id="port-label" for="port-input" class:disabled={isServerRunning}>
          Port:
        </label>
        <input
          id="port-input"
          type="number"
          min="1025" 
          max="65535" 
          bind:value={port}
          on:change={updateSettings}
          disabled={isServerRunning}
          class:disabled-input={isServerRunning}
        />
      </div>
      
      <div class="setting-item">
        <label id="ram-label" for="ram-input" class:disabled={isServerRunning}>
          RAM (GB):
        </label>
        <input
          id="ram-input"
          type="number"
          min="1" 
          max="16" 
          bind:value={maxRam}
          on:change={updateSettings}
          disabled={isServerRunning}
          class:disabled-input={isServerRunning}
        />
      </div>
    </div>
    
    <div class="auto-start-section">
      <div class="auto-start-item">
        <input
          type="checkbox"
          id="auto-start-minecraft"
          bind:checked={autoStartMinecraft}
          on:change={updateSettings}
        />
        <label for="auto-start-minecraft">Auto-start Minecraft server on app launch</label>
      </div>
    </div>
    
    <div class="button-group">
      <button 
        class="control-button start-button" 
        on:click={startServer}
        disabled={isServerRunning || !serverPath}
      >
        Start Minecraft Server
      </button>
      <button 
        class="control-button stop-button" 
        on:click={stopServer}
        disabled={!isServerRunning}
      >
        Stop Minecraft Server
      </button>
      <button 
        class="control-button kill-button" 
        on:click={killServer}
        disabled={!isServerRunning}
      >
        Force Kill
      </button>
    </div>
  </div>
  
  <div class="players-section">
    <h4>Online Players ({playerNames.length})</h4>
    {#if playerNames.length === 0}
      <p class="no-players">No players online</p>
    {:else}
      <ul class="player-list">
        {#each playerNames as playerName}
          <li class="player-item" on:contextmenu={(e) => showPlayerContextMenu(e, playerName)}>
            {playerName}
          </li>
        {/each}
      </ul>
    {/if}
  </div>
  
  <!-- Management Server Section -->
  <div class="management-server-section">
    <h3>Client Management Server (Port {managementPort})</h3>
    <div class="management-status">
      <span class="status-label">Management Server Status:</span>
      <span class="status-value" 
            class:status-running={managementServerStatus === 'running'} 
            class:status-stopped={managementServerStatus === 'stopped'}
            class:status-starting={managementServerStatus === 'starting'}
            class:status-stopping={managementServerStatus === 'stopping'}>
        {#if managementServerStatus === 'starting'}
          Starting...
        {:else if managementServerStatus === 'stopping'}
          Stopping...
        {:else if managementServerStatus === 'running'}
          Running
        {:else}
          Stopped
        {/if}
      </span>
    </div>
    
    {#if managementServerStatus === 'running'}
      <div class="management-info">
        <p class="management-detail">Port: {managementPort}</p>
        <p class="management-detail">Connected clients: {connectedClients}</p>
        <p class="management-url">Server URL: http://localhost:{managementPort}</p>
      </div>
    {/if}
    
    <div class="management-controls">
      <input
        type="number"
        min="1025"
        max="65535"
        bind:value={managementPort}
        disabled={managementServerStatus === 'running' || managementServerStatus === 'starting'}
        placeholder="8080"
        class="port-input"
      />
      
      <div class="auto-start-section">
        <div class="auto-start-item">
          <input
            type="checkbox"
            id="auto-start-management"
            bind:checked={autoStartManagement}
            on:change={updateSettings}
          />
          <label for="auto-start-management">Auto-start management server on app launch</label>
        </div>
      </div>
      
      <div class="button-group">
        <button 
          class="control-button start-button" 
          on:click={startManagementServer}
          disabled={managementServerStatus === 'running' || managementServerStatus === 'starting' || !serverPath}
        >
          {managementServerStatus === 'starting' ? 'Starting...' : 'Start Management Server'}
        </button>
        <button 
          class="control-button stop-button" 
          on:click={stopManagementServer}
          disabled={managementServerStatus === 'stopped' || managementServerStatus === 'stopping'}
        >
          {managementServerStatus === 'stopping' ? 'Stopping...' : 'Stop Management Server'}
        </button>
      </div>
    </div>
    
    <div class="management-help">
      <p class="help-text">
        The management server allows remote clients to connect and sync mods/configurations.
        Clients should connect to: <strong>your-server-ip:{managementPort}</strong>
      </p>
    </div>
  </div>
</div>

{#if $playerState.contextMenu.visible}
  <PlayerContextMenu />
{/if}

<style>
  .settings {
    display: flex;
    flex-direction: column;
    align-items: center;
    gap: 1rem;
    margin-bottom: 1.5rem;
    padding: 0.8rem;
    margin-top: 1.5rem;
    background-color: rgba(30, 30, 30, 0.5);
    border-radius: 8px;
    max-width: 300px;
    margin-left: auto;
    margin-right: auto;
  }
  
  .settings label {
    font-weight: normal;
    color: #dddddd !important;
    margin-right: 0.5rem;
  }
  
  .setting-item label {
    color: #dddddd !important;
  }
  
  /* Styling for disabled inputs when server is running */
  label.disabled {
    opacity: 0.7;
    position: relative;
    cursor: not-allowed;
  }
  
  /* Remove the underline indicator to reduce clutter */
  label.disabled::after {
    content: "";
    display: none;
  }
  
  .setting-item {
    position: relative;
    display: flex;
    width: 100%;
    align-items: center;
    justify-content: space-between;
  }
  
  /* Show a single "Server running" indicator for the settings */
  .settings.has-running-server::before {
    content: "Server running";
    position: absolute;
    top: -20px;
    left: 50%;
    transform: translateX(-50%);
    font-size: 0.75rem;
    color: #ff8800;
    background-color: rgba(20, 20, 20, 0.7);
    padding: 3px 8px;
    border-radius: 4px;
    z-index: 10;
  }
  
  .disabled-input {
    cursor: not-allowed !important;
    background-color: #3a3a3a !important;
    color: #888 !important;
    border: 1px solid #555 !important;
    pointer-events: none;
    opacity: 0.7;
    box-shadow: inset 0 0 5px rgba(255, 0, 0, 0.2);
  }
  
  /* Player list styling */
  .players-section {
    margin-top: 1.5rem;
  }
  
  .player-list {
    list-style: none;
    padding: 0;
    margin: 0.5rem 0;
    max-width: 300px;
    margin-left: auto;
    margin-right: auto;
  }
  
  .player-item {
    padding: 0.5rem;
    border-bottom: 1px solid rgba(255, 255, 255, 0.1);
    cursor: pointer;
  }
  
  .player-item:hover {
    background-color: rgba(66, 153, 225, 0.2);
  }
  
  .no-players {
    color: rgba(255, 255, 255, 0.5);
    font-style: italic;
  }
  
  /* Server control buttons */
  .button-group {
    display: flex;
    justify-content: center;
    gap: 0.5rem;
    margin-top: 1rem;
  }
  
  .control-button {
    padding: 0.5rem 1rem;
    border-radius: 4px;
    border: 1px solid transparent;
    cursor: pointer;
    font-weight: bold;
    transition: all 0.2s ease;
  }
  
  .control-button:disabled {
    opacity: 0.5;
    cursor: not-allowed;
  }
  
  .start-button {
    background-color: #4caf50;
    color: white;
  }
  
  .start-button:hover:not(:disabled) {
    background-color: #3f9142;
  }
  
  .stop-button {
    background-color: #f44336;
    color: white;
  }
  
  .stop-button:hover:not(:disabled) {
    background-color: #d32f2f;
  }
  
  .kill-button {
    background-color: #ff9800;
    color: white;
  }
    .kill-button:hover:not(:disabled) {
    background-color: #ef6c00;
  }

  label {
    display: block;
    margin-bottom: 1rem;
  }
  
  input[type="number"] {
    padding: 0.5rem;
    border-radius: 4px;
    border: 1px solid #444;
    background-color: #333;
    color: white;
    width: 100px;
    text-align: center;
    font-size: 0.9rem;
  }
  
  input[type="number"]:focus {
    outline: none;
    border-color: #666;
    box-shadow: 0 0 0 2px rgba(100, 100, 100, 0.3);
  }
  
  input[type="number"]::-webkit-inner-spin-button,
  input[type="number"]::-webkit-outer-spin-button {
    opacity: 1;
    height: 22px;
  }

  .status-display {
    display: flex;
    align-items: center;
    justify-content: center;
    gap: 0.5rem;
    margin: 1rem 0;
    padding: 0.5rem;
    background-color: rgba(30, 30, 30, 0.3);
    border-radius: 4px;
  }
  
  .status-label {
    font-weight: bold;
    color: #dddddd;
  }
  
  .status-value {
    font-weight: bold;
  }
  
  .status-running {
    color: #4caf50;
  }
  
  .status-stopped {
    color: #f44336;
  }

  /* Management Server Styles */
  .management-server-section {
    background: rgba(32, 32, 32, 0.8);
    border: 1px solid #444;
    border-radius: 8px;
    padding: 1rem;
    margin-top: 1rem;
  }
  
  .management-server-section h3 {
    color: #4299e1;
    margin-bottom: 1rem;
    border-bottom: 1px solid #4299e1;
    padding-bottom: 0.5rem;
  }
  
  .management-status {
    display: flex;
    align-items: center;
    gap: 0.5rem;
    margin-bottom: 1rem;
  }
  
  .status-starting, .status-stopping {
    color: #f59e0b !important;
  }
  
  .management-info {
    background: rgba(16, 185, 129, 0.1);
    border: 1px solid rgba(16, 185, 129, 0.3);
    border-radius: 6px;
    padding: 0.75rem;
    margin-bottom: 1rem;
  }
  
  .management-detail {
    margin: 0.25rem 0;
    color: #e2e8f0;
    font-size: 0.9rem;
  }
  
  .management-url {
    margin: 0.5rem 0 0 0;
    color: #4299e1;
    font-family: monospace;
    font-size: 0.85rem;
    background: rgba(66, 153, 225, 0.1);
    padding: 0.25rem 0.5rem;
    border-radius: 4px;
  }
  
  .management-controls {
    display: flex;
    flex-direction: column;
    gap: 1rem;
    margin-bottom: 1rem;
  }
  
  .port-input {
    background-color: #2d2d2d;
    color: white;
    border: 1px solid #555;
    border-radius: 4px;
    padding: 0.5rem;
    font-size: 1rem;
    width: 100px;
  }
  
  .port-input:focus {
    outline: none;
    border-color: #4299e1;
    box-shadow: 0 0 0 2px rgba(66, 153, 225, 0.2);
  }
  
  .port-input:disabled {
    background-color: #3a3a3a;
    color: #888;
    cursor: not-allowed;
    opacity: 0.7;
  }
  
  .management-help {
    background: rgba(245, 158, 11, 0.1);
    border: 1px solid rgba(245, 158, 11, 0.3);
    border-radius: 6px;
    padding: 0.75rem;
  }
  
  .help-text {
    margin: 0;
    color: #e2e8f0;
    font-size: 0.85rem;
    line-height: 1.4;
  }
  
  .help-text strong {
    color: #f59e0b;
    font-family: monospace;
  }
  
  /* Auto-start section styles */
  .auto-start-section {
    background: rgba(32, 32, 32, 0.5);
    border: 1px solid #444;
    border-radius: 6px;
    padding: 0.75rem;
    margin: 1rem 0;
  }
  
  .auto-start-item {
    display: flex;
    align-items: center;
    gap: 0.5rem;
  }
  
  .auto-start-item input[type="checkbox"] {
    width: auto;
    margin: 0;
    cursor: pointer;
  }
  
  .auto-start-item label {
    color: #e2e8f0;
    font-size: 0.9rem;
    margin: 0;
    cursor: pointer;
    user-select: none;
  }
  
  .auto-start-item input[type="checkbox"]:checked + label {
    color: #4caf50;
  }

  .update-section {
    display: flex;
    flex-direction: column;
    align-items: center;
    gap: 0.5rem;
    margin-top: 0.5rem;
  }

  .check-updates-button {
    background: rgba(255, 255, 255, 0.1);
    border: none;
    border-radius: 4px;
    padding: 0.25rem 0.5rem;
    cursor: pointer;
    transition: background 0.2s;
  }

  .check-updates-button:hover:not(:disabled) {
    background: rgba(255, 255, 255, 0.2);
  }

  .update-notice {
    color: #fbbf24;
    font-size: 0.9rem;
    text-align: center;
  }

  .update-notice.up-to-date {
    color: #a0e881;
  }
</style>
