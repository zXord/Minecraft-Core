<!-- @ts-ignore -->
<script lang="ts">  /// <reference path="../../electron.d.ts" />
  import { onMount, onDestroy } from 'svelte';
  import { get } from 'svelte/store';  import { serverState, updateServerMetrics } from '../../stores/serverState.js';
  import { playerState, updateOnlinePlayers, showContextMenu } from '../../stores/playerState.js';
  import PlayerContextMenu from '../players/PlayerContextMenu.svelte';
  import { validateServerPath } from '../../utils/folderUtils.js';
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
  $: port = $serverState?.port || 25565;
  $: maxRam = $serverState?.maxRam || 4;

  // Management server state
  let managementServerStatus = 'stopped'; // stopped, starting, running, stopping
  let managementPort = 8080;
  let connectedClients = 0;
  
  // Auto-start settings
  let autoStartMinecraft = false;
  let autoStartManagement = false;
  
  // Help text dismissal
  let helpTextDismissed = false;
  
  // Function to dismiss help text
  function dismissHelpText() {
    helpTextDismissed = true;
    if (typeof window !== 'undefined' && window.localStorage) {
      localStorage.setItem('managementHelpDismissed', 'true');
    }
  }
  
  // Version update tracking
  $: currentMcVersion = $settingsStore.mcVersion;
  $: currentFabricVersion = $settingsStore.fabricVersion;
  $: latestMcVersion = $latestVersions.mc;
  $: latestFabricVersion = $latestVersions.fabric;
  $: mcUpdateAvailable = currentMcVersion && latestMcVersion && compareVersions(latestMcVersion, currentMcVersion) > 0;
  $: fabricUpdateAvailable = currentFabricVersion && latestFabricVersion && compareVersions(latestFabricVersion, currentFabricVersion) > 0;


  let updateChecked = false;
  $: upToDate = updateChecked && !mcUpdateAvailable && !fabricUpdateAvailable && latestMcVersion && latestFabricVersion;
  async function checkVersionUpdates() {
    
    await refreshLatestVersions(currentMcVersion);
    
    

    
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
    serverState.update(state => ({ ...state, status: 'Running' }));
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
    // Load dismissed help text state
    if (typeof window !== 'undefined' && window.localStorage) {
      helpTextDismissed = localStorage.getItem('managementHelpDismissed') === 'true';
    }
    
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
    window.electron.invoke('update-settings', {      port: port,
      maxRam: maxRam,
      autoStartMinecraft: autoStartMinecraft,
      autoStartManagement: autoStartManagement
    }).catch(() => {
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
  <!-- COMPACT HEADER - Everything on one line -->
  <div class="compact-header">
    <h3>Minecraft Server Control Panel</h3>
    <div class="header-actions">
      <button class="check-updates-button" on:click={checkVersionUpdates}>Check Updates</button>
      {#if mcUpdateAvailable || fabricUpdateAvailable}
        <span class="update-notice">
          {#if mcUpdateAvailable}MC {currentMcVersion} → {latestMcVersion}{/if}
          {#if fabricUpdateAvailable} Fabric {currentFabricVersion} → {latestFabricVersion}{/if}
        </span>
      {:else if upToDate}
        <span class="update-notice up-to-date">All versions are up to date</span>
      {/if}
    </div>
  </div>

  <!-- MINECRAFT SERVER SECTION -->
  <div class="minecraft-server-section">
    <div class="minecraft-header">
      <h4>Minecraft Server</h4>
      <div class="status-compact">
        <span class="status-label">Status:</span>
        <span class="status-value" class:status-running={status === 'Running'} class:status-stopped={status !== 'Running'}>
          {status}
        </span>
      </div>
    </div>

    <!-- Main controls -->
    <div class="main-controls">
    
    <!-- Settings Group -->
    <div class="settings-group">
      <div class="input-group">
        <label for="port-input">Port:</label>
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
      
      <div class="input-group">
        <label for="ram-input">RAM:</label>
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
        <span class="unit">GB</span>
      </div>
    </div>
    
    <!-- Auto-start checkbox -->
    <div class="auto-start-compact">
      <input
        type="checkbox"
        id="auto-start-minecraft"
        bind:checked={autoStartMinecraft}
        on:change={updateSettings}
      />
      <label for="auto-start-minecraft">Auto-start server</label>
    </div>
    
    <!-- Action buttons -->
    <div class="button-group-compact">
      <button 
        class="btn-compact start-button" 
        on:click={startServer}
        disabled={isServerRunning || !serverPath}
      >
        Start
      </button>
      <button 
        class="btn-compact stop-button" 
        on:click={stopServer}
        disabled={!isServerRunning}
      >
        Stop
      </button>
      <button 
        class="btn-compact kill-button" 
        on:click={killServer}
        disabled={!isServerRunning}
      >
        Kill
      </button>
    </div>
    </div>
  </div>
  
  <!-- COMPACT MANAGEMENT SERVER - Horizontal layout -->
  <div class="management-compact">
    <div class="management-header">
      <h4>Client Management Server</h4>
      <div class="management-status-compact">
        <span class="status-label">Status:</span>
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
    </div>
    
    <div class="management-controls-compact">
      <!-- Info when running -->
      {#if managementServerStatus === 'running'}
        <div class="management-info-compact">
          <span>Port: {managementPort}</span>
          <span>Clients: {connectedClients}</span>
          <span class="management-url">http://localhost:{managementPort}</span>
        </div>
      {/if}
      
      <!-- Controls row -->
      <div class="management-row">
        <div class="input-group">
          <label for="management-port-input">Port:</label>
          <input
            id="management-port-input"
            type="number"
            min="1025"
            max="65535"
            bind:value={managementPort}
            disabled={managementServerStatus === 'running' || managementServerStatus === 'starting'}
            class="port-input"
          />
        </div>
        
        <div class="auto-start-compact">
          <input
            type="checkbox"
            id="auto-start-management"
            bind:checked={autoStartManagement}
            on:change={updateSettings}
          />
          <label for="auto-start-management">Auto-start</label>
        </div>
        
        <div class="button-group-compact">
          <button 
            class="btn-compact start-button" 
            on:click={startManagementServer}
            disabled={managementServerStatus === 'running' || managementServerStatus === 'starting' || !serverPath}
          >
            {managementServerStatus === 'starting' ? 'Starting...' : 'Start'}
          </button>
          <button 
            class="btn-compact stop-button" 
            on:click={stopManagementServer}
            disabled={managementServerStatus === 'stopped' || managementServerStatus === 'stopping'}
          >
            {managementServerStatus === 'stopping' ? 'Stopping...' : 'Stop'}
          </button>
        </div>
      </div>
      
      <!-- Help text - compact -->
      {#if !helpTextDismissed}
        <div class="management-help-compact">
          <span>Remote clients connect to: <strong>your-server-ip:{managementPort}</strong></span>
          <button class="dismiss-btn" on:click={dismissHelpText} title="Dismiss this message">×</button>
        </div>
      {/if}
    </div>
  </div>
  
  <!-- COMPACT PLAYERS - One line -->
  <div class="players-compact">
    <span class="players-label">Online Players ({playerNames.length}):</span>
    {#if playerNames.length === 0}
      <span class="no-players">No players online</span>
    {:else}
      <div class="player-list-inline">
        {#each playerNames as playerName (playerName)}
          <span class="player-name" role="button" tabindex="0" on:contextmenu={(e) => showPlayerContextMenu(e, playerName)}>
            {playerName}
          </span>
        {/each}
      </div>
    {/if}
  </div>
</div>

{#if $playerState.contextMenu.visible}
  <PlayerContextMenu />
{/if}

<style>
  /* COMPACT HORIZONTAL LAYOUT STYLES */
  .server-controls {
    background: rgba(20, 20, 20, 0.9);
    border-radius: 8px;
    padding: 1rem;
    width: 100%;
    margin: 0 0 1rem 0;
    box-sizing: border-box;
  }

  /* Header - horizontal layout */
  .compact-header {
    display: flex;
    justify-content: space-between;
    align-items: center;
    margin-bottom: 0.75rem;
    padding-bottom: 0.5rem;
    border-bottom: 1px solid #444;
  }

  .compact-header h3 {
    margin: 0;
    font-size: 1.1rem;
    color: #fff;
  }

  .header-actions {
    display: flex;
    align-items: center;
    gap: 0.75rem;
  }

  .check-updates-button {
    background: rgba(255, 255, 255, 0.1);
    border: 1px solid #555;
    border-radius: 4px;
    padding: 0.25rem 0.5rem;
    color: #fff;
    cursor: pointer;
    font-size: 0.8rem;
    transition: background 0.2s;
  }

  .check-updates-button:hover:not(:disabled) {
    background: rgba(255, 255, 255, 0.2);
  }

  .update-notice {
    font-size: 0.75rem;
    color: #fbbf24;
  }

  .update-notice.up-to-date {
    color: #10b981;
  }

  /* Main controls - everything horizontal */
  .main-controls {
    display: flex;
    align-items: center;
    gap: 1rem;
    background: rgba(30, 30, 30, 0.6);
    border: 1px solid #444;
    border-radius: 6px;
    padding: 0.75rem;
    margin: 0;
    flex-wrap: wrap;
  }

  .status-compact {
    display: flex;
    align-items: center;
    gap: 0.5rem;
    font-size: 0.85rem;
  }

  .settings-group {
    display: flex;
    gap: 1rem;
  }

  .input-group {
    display: flex;
    align-items: center;
    gap: 0.375rem;
    font-size: 0.8rem;
  }

  .input-group label {
    color: #ccc;
    margin: 0;
    white-space: nowrap;
  }

  .input-group input[type="number"] {
    padding: 0.25rem 0.375rem;
    border-radius: 4px;
    border: 1px solid #555;
    background-color: #333;
    color: white;
    width: 75px;
    text-align: center;
    font-size: 0.8rem;
  }

  .unit {
    color: #888;
    font-size: 0.75rem;
  }

  .auto-start-compact {
    display: flex;
    align-items: center;
    gap: 0.375rem;
    font-size: 0.8rem;
  }

  .auto-start-compact input[type="checkbox"] {
    margin: 0;
    transform: scale(0.9);
  }

  .auto-start-compact label {
    color: #ccc;
    margin: 0;
    cursor: pointer;
    white-space: nowrap;
  }

  .button-group-compact {
    display: flex;
    gap: 0.25rem;
    margin-left: auto;
    align-items: center;
    flex-shrink: 0;
  }

  .btn-compact {
    padding: 0 !important;
    margin: 0 !important;
    border-radius: 4px;
    border: 1px solid transparent;
    cursor: pointer;
    font-weight: 500;
    font-size: 0.75rem !important;
    transition: all 0.2s ease;
    width: 65px !important;
    height: 28px !important;
    min-width: 65px !important;
    max-width: 65px !important;
    display: inline-flex !important;
    align-items: center !important;
    justify-content: center !important;
    text-align: center !important;
    flex-shrink: 0 !important;
    flex-grow: 0 !important;
    box-sizing: border-box !important;
    line-height: 1 !important;
    font-family: inherit !important;
  }
  
  /* Button states */
  .btn-compact:disabled {
    opacity: 0.5;
    cursor: not-allowed;
  }

  .start-button {
    background-color: #10b981;
    color: white;
    width: 65px !important;
    height: 28px !important;
    min-width: 65px !important;
    max-width: 65px !important;
    padding: 0 !important;
    text-overflow: ellipsis;
    overflow: hidden;
    white-space: nowrap;
  }

  .start-button:hover:not(:disabled) {
    background-color: #059669;
  }

  .stop-button {
    background-color: #6b7280;
    color: white;
    width: 65px !important;
    height: 28px !important;
    min-width: 65px !important;
    max-width: 65px !important;
    padding: 0 !important;
    text-overflow: ellipsis;
    overflow: hidden;
    white-space: nowrap;
  }

  .stop-button:hover:not(:disabled) {
    background-color: #4b5563;
  }

  .kill-button {
    background-color: #ef4444;
    color: white;
    width: 65px !important;
    height: 28px !important;
    min-width: 65px !important;
    max-width: 65px !important;
    padding: 0 !important;
    text-overflow: ellipsis;
    overflow: hidden;
    white-space: nowrap;
  }

  .kill-button:hover:not(:disabled) {
    background-color: #dc2626;
  }

  /* Players section - inline */
  .players-compact {
    display: flex;
    align-items: center;
    gap: 0.75rem;
    background: rgba(30, 30, 30, 0.4);
    border: 1px solid #444;
    border-radius: 6px;
    padding: 0.5rem 0.75rem;
    margin-top: 0;
    font-size: 0.85rem;
  }

  .players-label {
    color: #ccc;
    font-weight: 500;
    white-space: nowrap;
  }

  .no-players {
    color: #888;
    font-style: italic;
  }

  .player-list-inline {
    display: flex;
    gap: 0.5rem;
    flex-wrap: wrap;
  }

  .player-name {
    background: rgba(66, 153, 225, 0.2);
    color: #93c5fd;
    padding: 0.125rem 0.375rem;
    border-radius: 3px;
    cursor: pointer;
    font-size: 0.8rem;
  }

  .player-name:hover {
    background: rgba(66, 153, 225, 0.3);
  }

  /* Minecraft server section */
  .minecraft-server-section {
    background: rgba(30, 30, 30, 0.6);
    border: 1px solid #444;
    border-radius: 6px;
    padding: 0.75rem;
    margin-bottom: 0.75rem;
  }

  .minecraft-header {
    display: flex;
    justify-content: space-between;
    align-items: center;
    margin-bottom: 0.5rem;
    padding-bottom: 0.375rem;
    border-bottom: 1px solid #10b981;
  }

  .minecraft-header h4 {
    margin: 0;
    font-size: 0.95rem;
    color: #10b981;
  }

  /* Management server - compact */
  .management-compact {
    background: rgba(30, 30, 30, 0.6);
    border: 1px solid #444;
    border-radius: 6px;
    padding: 0.75rem;
    margin-bottom: 0.75rem;
  }

  .management-header {
    display: flex;
    justify-content: space-between;
    align-items: center;
    margin-bottom: 0.5rem;
    padding-bottom: 0.375rem;
    border-bottom: 1px solid #4299e1;
  }

  .management-header h4 {
    margin: 0;
    font-size: 0.95rem;
    color: #4299e1;
  }

  .management-status-compact {
    display: flex;
    align-items: center;
    gap: 0.375rem;
    font-size: 0.8rem;
  }

  .management-controls-compact {
    display: flex;
    flex-direction: column;
    gap: 0.5rem;
  }

  .management-info-compact {
    display: flex;
    gap: 1rem;
    background: rgba(16, 185, 129, 0.1);
    border: 1px solid rgba(16, 185, 129, 0.3);
    border-radius: 4px;
    padding: 0.375rem 0.5rem;
    font-size: 0.75rem;
  }

  .management-info-compact span {
    color: #d1fae5;
  }

  .management-url {
    font-family: monospace;
    color: #4299e1 !important;
    background: rgba(66, 153, 225, 0.1);
    padding: 0.125rem 0.25rem;
    border-radius: 3px;
  }

  .management-row {
    display: flex;
    align-items: center;
    gap: 1rem;
    flex-wrap: wrap;
  }

  .management-help-compact {
    font-size: 0.7rem;
    color: #888;
    background: rgba(245, 158, 11, 0.1);
    border: 1px solid rgba(245, 158, 11, 0.2);
    border-radius: 4px;
    padding: 0.375rem 0.5rem;
    display: flex;
    justify-content: space-between;
    align-items: center;
    gap: 0.5rem;
  }

  .management-help-compact strong {
    color: #f59e0b;
    font-family: monospace;
  }

  .dismiss-btn {
    background: none;
    border: none;
    color: #f59e0b;
    cursor: pointer;
    font-size: 1rem;
    font-weight: bold;
    padding: 0;
    width: 16px;
    height: 16px;
    display: flex;
    align-items: center;
    justify-content: center;
    border-radius: 50%;
    transition: background-color 0.2s;
  }

  .dismiss-btn:hover {
    background-color: rgba(245, 158, 11, 0.2);
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
  /* Status styling */
  .status-label {
    font-weight: 500;
    color: #ccc;
  }
  
  .status-value {
    font-weight: 600;
  }
  
  .status-running {
    color: #10b981;
  }
  
  .status-stopped {
    color: #ef4444;
  }

  .status-starting, .status-stopping {
    color: #f59e0b;
  }

  /* Input focus states */
  .input-group input[type="number"]:focus {
    outline: none;
    border-color: #666;
    box-shadow: 0 0 0 2px rgba(100, 100, 100, 0.3);
  }
  
  .port-input:focus {
    outline: none;
    border-color: #4299e1;
    box-shadow: 0 0 0 2px rgba(66, 153, 225, 0.2);
  }

  /* Port input styling */
  .port-input {
    background-color: #2d2d2d;
    color: white;
    border: 1px solid #555;
    border-radius: 4px;
    padding: 0.375rem;
    font-size: 0.8rem;
    width: 90px;
    text-align: center;
  }
  
  .port-input:disabled {
    background-color: #3a3a3a;
    color: #888;
    cursor: not-allowed;
    opacity: 0.7;
  }

  /* Responsive adjustments */
  @media (max-width: 768px) {
    .main-controls {
      flex-direction: column;
      align-items: stretch;
      gap: 0.5rem;
    }
    
    .settings-group {
      justify-content: space-between;
    }
    
    .button-group-compact {
      margin-left: 0;
      justify-content: center;
    }
    
    .management-row {
      flex-direction: column;
      align-items: stretch;
      gap: 0.5rem;
    }
  }
</style>
