<script>
  import { onMount, onDestroy } from 'svelte';
  import ConfirmationDialog from '../common/ConfirmationDialog.svelte';
  import { errorMessage, successMessage } from '../../stores/modStore.js';
  import { createEventDispatcher } from 'svelte';
  
  // Props
  export let instance = {
    serverIp: '',
    serverPort: '25565',
    path: '',
    id: '',
    name: '',
    type: 'client'
  }; // Client instance with serverIp, serverPort, path
  
  // Create event dispatcher
  const dispatch = createEventDispatcher();
  
  // Client state management
  let connectionStatus = 'disconnected';  // disconnected, connecting, connected
  let serverStatus = 'unknown';           // unknown, running, stopped
  let downloadStatus = 'unknown';         // unknown, needed, ready
  let downloadProgress = 0;
  let downloadSpeed = '0 MB/s';
  let isChecking = false;
  let lastCheck = null;
  
  // Connection check interval
  let connectionCheckInterval;
  let statusCheckInterval;
  
  // Active tab tracking
  let activeTab = 'play';
  const tabs = ['play', 'settings'];
  
  // Settings
  let deleteFiles = false;
  let showDeleteConfirmation = false;
  
  // Connect to the Minecraft Core server
  async function connectToServer() {
    if (!instance || !instance.serverIp) {
      alert('Server address not configured');
      return;
    }
    
    connectionStatus = 'connecting';
    
    try {
      // Simulate connection test for now
      // Future: Implement actual server connection
      setTimeout(() => {
        connectionStatus = 'connected';
        checkServerStatus();
      }, 1500);
    } catch (err) {
      console.error('Failed to connect:', err);
      connectionStatus = 'disconnected';
    }
  }
  
  // Check if the Minecraft server is running
  async function checkServerStatus() {
    if (connectionStatus !== 'connected') {
      serverStatus = 'unknown';
      return;
    }
    
    try {
      // Simulate server status check for now
      // Future: Implement actual status check with the server app
      isChecking = true;
      serverStatus = Math.random() > 0.5 ? 'running' : 'stopped';
      lastCheck = new Date();
      isChecking = false;
    } catch (err) {
      console.error('Failed to check server status:', err);
      serverStatus = 'unknown';
      isChecking = false;
    }
  }
  
  // Check if client files need to be downloaded
  async function checkDownloadStatus() {
    // For now, assume files are ready
    // Future: Implement actual file checking based on server mods
    downloadStatus = 'ready';
  }
  
  // Start Minecraft client
  async function launchMinecraft() {
    if (serverStatus !== 'running') {
      alert('The Minecraft server is not running. Please wait for the server to start.');
      return;
    }
    
    if (downloadStatus !== 'ready') {
      alert('Client files are not ready. Please wait for download completion.');
      return;
    }
    
    // Future: Implement Microsoft login and client launch
    alert('Minecraft client launch not implemented yet. This will launch the Minecraft client with the correct profile.');
  }
  
  // Set up periodic checks
  function setupChecks() {
    // Check connection immediately
    connectToServer();
    
    // Set up periodic connection check
    connectionCheckInterval = setInterval(() => {
      if (connectionStatus === 'disconnected') {
        connectToServer();
      }
    }, 30000); // Every 30 seconds
    
    // Set up periodic server status check
    statusCheckInterval = setInterval(() => {
      if (connectionStatus === 'connected') {
        checkServerStatus();
      }
    }, 10000); // Every 10 seconds
    
    // Check download status
    checkDownloadStatus();
  }
  
  // Clean up on component unmount
  onDestroy(() => {
    clearInterval(connectionCheckInterval);
    clearInterval(statusCheckInterval);
  });
  
  onMount(() => {
    // Initialize client functionality
    setupChecks();
  });
  
  // Settings functions
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
          errorMessage.set(res.warning);
          setTimeout(() => errorMessage.set(''), 5000);
        }
        dispatch('deleted', { id: instance.id });
      } else {
        errorMessage.set('Delete failed: ' + (res.error || 'Unknown error'));
        setTimeout(() => errorMessage.set(''), 5000);
      }
    } catch (err) {
      errorMessage.set('Error deleting instance: ' + (err.message || 'Unknown error'));
      setTimeout(() => errorMessage.set(''), 5000);
    }
  }
</script>

<div class="client-container">
  <header class="client-header">
    <h1>Minecraft Client</h1>
    <div class="connection-status">
      {#if connectionStatus === 'connected'}
        <div class="status-indicator connected" title="Connected to Minecraft Core server">
          <span class="status-dot"></span>
          <span class="status-text">Connected</span>
        </div>
      {:else if connectionStatus === 'connecting'}
        <div class="status-indicator connecting" title="Connecting to Minecraft Core server">
          <span class="status-dot"></span>
          <span class="status-text">Connecting...</span>
        </div>
      {:else}
        <div class="status-indicator disconnected" title="Not connected to Minecraft Core server">
          <span class="status-dot"></span>
          <span class="status-text">Disconnected</span>
        </div>
      {/if}
      
      {#if connectionStatus === 'connected'}
        <div class="server-details">
          <span class="server-address">{instance?.serverIp || 'Unknown'}{instance?.serverPort ? `:${instance.serverPort}` : ''}</span>
          
          {#if serverStatus === 'running'}
            <div class="status-indicator server-running" title="Minecraft server is running">
              <span class="status-dot"></span>
              <span class="status-text">Server Running</span>
            </div>
          {:else if serverStatus === 'stopped'}
            <div class="status-indicator server-stopped" title="Minecraft server is stopped">
              <span class="status-dot"></span>
              <span class="status-text">Server Stopped</span>
            </div>
          {:else}
            <div class="status-indicator server-unknown" title="Minecraft server status unknown">
              <span class="status-dot"></span>
              <span class="status-text">Server Status Unknown</span>
            </div>
          {/if}
        </div>
      {/if}
    </div>
    
    <!-- Add tabs for navigation -->
    <div class="client-tabs">
      {#each tabs as tab}
        <button 
          class="tab-button {activeTab === tab ? 'active' : ''}" 
          on:click={() => activeTab = tab}
        >
          {tab === 'play' ? 'Play' : 'Settings'}
        </button>
      {/each}
    </div>
  </header>
  
  <div class="client-content">
    {#if activeTab === 'play'}
      <div class="client-main">
        <div class="client-status">
          {#if downloadStatus === 'needed'}
            <div class="download-status">
              <h2>Downloading Required Files</h2>
              <div class="progress-bar">
                <div class="progress-fill" style="width: {downloadProgress}%"></div>
              </div>
              <p class="progress-text">Progress: {downloadProgress}% ({downloadSpeed})</p>
            </div>
          {:else if downloadStatus === 'ready'}
            <div class="ready-status">
              <h2>Ready to Play</h2>
              <p>All required files are downloaded and ready.</p>
              
              {#if serverStatus === 'running'}
                <button class="play-button" on:click={launchMinecraft}>
                  PLAY
                </button>
              {:else}
                <button class="play-button disabled" disabled title="The server is not running">
                  PLAY
                </button>
                <p class="server-status-message">
                  The server is not running. Please wait for it to start.
                </p>
              {/if}
            </div>
          {:else}
            <div class="checking-status">
              <h2>Checking Status</h2>
              <p>Checking for required files...</p>
            </div>
          {/if}
        </div>
        
        <div class="last-check">
          {#if lastCheck}
            Last checked: {lastCheck.toLocaleTimeString()}
          {/if}
          
          {#if isChecking}
            <span class="checking">Checking...</span>
          {:else}
            <button class="refresh-button" on:click={checkServerStatus}>
              Refresh
            </button>
          {/if}
        </div>
      </div>
    {:else if activeTab === 'settings'}
      <div class="settings-container">
        <div class="settings-section">
          <h2>Client Settings</h2>
          
          <div class="settings-info">
            <div class="info-item">
              <span class="info-label">Name:</span>
              <span class="info-value">{instance.name || 'Unnamed Client'}</span>
            </div>
            <div class="info-item">
              <span class="info-label">Server Address:</span>
              <span class="info-value">{instance.serverIp || 'Not configured'}{instance.serverPort ? `:${instance.serverPort}` : ''}</span>
            </div>
            <div class="info-item">
              <span class="info-label">Client Path:</span>
              <span class="info-value">{instance.path || 'Not configured'}</span>
            </div>
          </div>
          
          <div class="danger-zone">
            <h3>Danger Zone</h3>
            <p class="warning-text">These actions cannot be undone. Please be careful.</p>
            
            {#if instance.path}
              <div class="delete-options">
                <label class="delete-files-option">
                  <input type="checkbox" bind:checked={deleteFiles} />
                  <span>Delete all client files ({instance.path})</span>
                </label>
                <p class="delete-info">If checked, the entire client folder will be permanently deleted.</p>
              </div>
            {/if}
            
            <button 
              class="delete-instance-button" 
              on:click={promptDelete}
            >
              🗑️ Delete Instance
            </button>
          </div>
        </div>
      </div>
    {/if}
  </div>
</div>

<!-- Delete Confirmation Dialog -->
<ConfirmationDialog
  bind:visible={showDeleteConfirmation}
  title="Delete Client Instance"
  message={deleteFiles ? 
    `Are you sure you want to delete the client instance "${instance.name}" and ALL CLIENT FILES? This action cannot be undone.` : 
    `Are you sure you want to delete the client instance "${instance.name}"? The client files will remain on disk.`}
  confirmText="Delete"
  cancelText="Cancel"
  confirmType="danger"
  backdropClosable={false}
  on:confirm={confirmDelete}
  on:cancel={() => showDeleteConfirmation = false}
/>

<style>
  .client-container {
    width: 100%;
    min-height: 100vh;
    display: flex;
    flex-direction: column;
  }
  
  .client-header {
    background-color: #1f2937;
    padding: 1rem 2rem;
    display: flex;
    flex-direction: column;
    align-items: center;
    border-bottom: 1px solid #374151;
  }
  
  .client-content {
    flex: 1;
    padding: 2rem;
    max-width: 1200px;
    margin: 0 auto;
    width: 100%;
  }
  
  h1, h2 {
    color: white;
    margin-bottom: 1rem;
    text-align: center;
  }
  
  p {
    color: #e2e8f0;
    text-align: center;
    margin-bottom: 1.5rem;
  }
  
  .connection-status {
    display: flex;
    flex-direction: column;
    align-items: center;
    margin-top: 1rem;
    gap: 0.5rem;
  }
  
  .status-indicator {
    display: flex;
    align-items: center;
    gap: 0.5rem;
    padding: 0.5rem 1rem;
    border-radius: 2rem;
    font-size: 0.875rem;
    font-weight: 500;
  }
  
  .status-dot {
    width: 10px;
    height: 10px;
    border-radius: 50%;
  }
  
  .connected {
    background-color: rgba(16, 185, 129, 0.2);
    color: #10b981;
  }
  
  .connected .status-dot {
    background-color: #10b981;
  }
  
  .connecting {
    background-color: rgba(245, 158, 11, 0.2);
    color: #f59e0b;
  }
  
  .connecting .status-dot {
    background-color: #f59e0b;
    animation: pulse 1.5s infinite;
  }
  
  .disconnected {
    background-color: rgba(239, 68, 68, 0.2);
    color: #ef4444;
  }
  
  .disconnected .status-dot {
    background-color: #ef4444;
  }
  
  .server-running {
    background-color: rgba(16, 185, 129, 0.2);
    color: #10b981;
  }
  
  .server-running .status-dot {
    background-color: #10b981;
  }
  
  .server-stopped {
    background-color: rgba(239, 68, 68, 0.2);
    color: #ef4444;
  }
  
  .server-stopped .status-dot {
    background-color: #ef4444;
  }
  
  .server-unknown {
    background-color: rgba(107, 114, 128, 0.2);
    color: #9ca3af;
  }
  
  .server-unknown .status-dot {
    background-color: #9ca3af;
  }
  
  .server-details {
    display: flex;
    flex-direction: column;
    align-items: center;
    margin-top: 0.5rem;
    gap: 0.5rem;
  }
  
  .server-address {
    color: #e2e8f0;
    font-family: monospace;
    background-color: #374151;
    padding: 0.25rem 0.5rem;
    border-radius: 0.25rem;
  }
  
  .client-main {
    display: flex;
    flex-direction: column;
    align-items: center;
    justify-content: center;
    height: 100%;
    min-height: 400px;
  }
  
  .client-status {
    text-align: center;
    background-color: #2d3748;
    border-radius: 8px;
    padding: 2rem;
    width: 100%;
    max-width: 500px;
    box-shadow: 0 4px 6px rgba(0, 0, 0, 0.1);
    margin-bottom: 2rem;
  }
  
  .progress-bar {
    width: 100%;
    height: 1rem;
    background-color: #1f2937;
    border-radius: 0.5rem;
    overflow: hidden;
    margin-bottom: 0.5rem;
  }
  
  .progress-fill {
    height: 100%;
    background-color: #3b82f6;
    transition: width 0.3s ease;
  }
  
  .progress-text {
    text-align: center;
    margin-bottom: 1rem;
    font-weight: 500;
    color: #e2e8f0;
  }
  
  .play-button {
    background-color: #3b82f6;
    color: white;
    border: none;
    border-radius: 4px;
    padding: 1rem 3rem;
    font-size: 1.5rem;
    font-weight: bold;
    cursor: pointer;
    transition: background-color 0.2s;
    width: 100%;
    max-width: 300px;
    margin: 1rem auto;
    display: block;
    text-transform: uppercase;
    letter-spacing: 2px;
  }
  
  .play-button:hover:not(.disabled) {
    background-color: #2563eb;
    transform: translateY(-2px);
    box-shadow: 0 4px 6px rgba(0, 0, 0, 0.1);
  }
  
  .play-button.disabled {
    background-color: #4b5563;
    cursor: not-allowed;
  }
  
  .server-status-message {
    color: #ef4444;
    font-size: 0.875rem;
    margin-top: 0.5rem;
  }
  
  .last-check {
    color: #9ca3af;
    font-size: 0.875rem;
    text-align: center;
    display: flex;
    align-items: center;
    gap: 1rem;
  }
  
  .checking {
    color: #f59e0b;
    font-style: italic;
  }
  
  .refresh-button {
    background-color: #4b5563;
    color: white;
    border: none;
    border-radius: 4px;
    padding: 0.25rem 0.5rem;
    font-size: 0.75rem;
    cursor: pointer;
  }
  
  .refresh-button:hover {
    background-color: #6b7280;
  }
  
  @keyframes pulse {
    0% {
      opacity: 0.6;
    }
    50% {
      opacity: 1;
    }
    100% {
      opacity: 0.6;
    }
  }
  
  .client-tabs {
    display: flex;
    margin-top: 1rem;
    gap: 1rem;
  }
  
  .tab-button {
    background: none;
    border: none;
    color: #9ca3af;
    padding: 0.5rem 1rem;
    font-size: 1rem;
    cursor: pointer;
    border-bottom: 2px solid transparent;
    transition: all 0.2s;
  }
  
  .tab-button:hover {
    color: white;
  }
  
  .tab-button.active {
    color: white;
    border-bottom: 2px solid #646cff;
  }
  
  .settings-container {
    width: 100%;
    max-width: 600px;
    margin: 2rem auto;
  }
  
  .settings-section {
    background: rgba(30, 41, 59, 0.5);
    border-radius: 8px;
    padding: 1.5rem;
    margin-bottom: 2rem;
  }
  
  .settings-section h2 {
    margin-top: 0;
    margin-bottom: 1.5rem;
    color: white;
    font-size: 1.5rem;
    border-bottom: 1px solid rgba(255, 255, 255, 0.1);
    padding-bottom: 0.5rem;
  }
  
  .settings-info {
    display: flex;
    flex-direction: column;
    gap: 0.75rem;
    margin-bottom: 2rem;
  }
  
  .info-item {
    display: flex;
    align-items: center;
  }
  
  .info-label {
    width: 130px;
    color: #9ca3af;
    font-size: 0.9rem;
  }
  
  .info-value {
    color: white;
    font-weight: 500;
  }
  
  .danger-zone {
    margin-top: 2rem;
    padding: 1rem;
    border: 1px solid #ff5555;
    border-radius: 6px;
    background: rgba(255, 0, 0, 0.1);
  }
  
  .danger-zone h3 {
    color: #ff5555;
    margin-top: 0;
    margin-bottom: 0.5rem;
  }
  
  .warning-text {
    color: rgba(255, 255, 255, 0.7);
    font-size: 0.9rem;
    margin-bottom: 1rem;
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
  }
  
  .delete-instance-button:hover {
    background: rgba(255, 0, 0, 0.3);
  }
</style> 