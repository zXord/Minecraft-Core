<!-- @ts-ignore -->
<script>
  /// <reference path="../../electron.d.ts" />
  import { createEventDispatcher, onMount } from 'svelte';
  
  // Event dispatcher to communicate with parent component
  const dispatch = createEventDispatcher();
  
  // State variables
  let path = '';
  let serverIp = '';
  let serverPort = '8080'; // Default management server port
  let installing = false;
  let installProgress = 0;
  let installSpeed = '0 MB/s';
  let installLogs = [];
  let step = 'chooseFolder'; // chooseFolder → configureConnection → done
  let ipValid = false;
  let connectionStatus = 'disconnected'; // disconnected, connecting, connected
  
  // Functions
  async function selectFolder() {
    try {
      const result = await window.electron.invoke('select-folder');
      if (!result) {
        return;
      }      path = result;
      
      // Note: Client paths should not update the global serverPath
      // The client instance will store its own path separately

      // Move to server IP configuration
      step = 'configureConnection';
    } catch (err) {
    }
  }
  
  function validateIp(ip) {
    // Simple IP validation regex - matches IPv4 addresses and hostnames
    const ipRegex = /^(([a-zA-Z0-9]|[a-zA-Z0-9][a-zA-Z0-9\-]*[a-zA-Z0-9])\.)*([A-Za-z0-9]|[A-Za-z0-9][A-Za-z0-9\-]*[A-Za-z0-9])$/;
    return ipRegex.test(ip);
  }
  
  function validatePort(port) {
    const portNum = parseInt(port, 10);
    return !isNaN(portNum) && portNum >= 1 && portNum <= 65535;
  }
  
  function onIpChange() {
    ipValid = validateIp(serverIp) && validatePort(serverPort);
  }
  
  async function testConnection() {
    if (!ipValid) return;
    
    connectionStatus = 'connecting';
    installLogs = [...installLogs, `Testing connection to ${serverIp}:${serverPort}...`];
    
    try {
      // Try to connect to the management server
      const managementUrl = `http://${serverIp}:${serverPort}/api/test`;
      
      const response = await fetch(managementUrl, {
        method: 'GET',
        headers: {
          'Content-Type': 'application/json'
        },
        // Set a timeout
        signal: AbortSignal.timeout(10000) // 10 second timeout
      });
      
      if (!response.ok) {
        throw new Error(`Server responded with ${response.status}: ${response.statusText}`);
      }
      
      const data = await response.json();
      
      if (data.success) {
        connectionStatus = 'connected';
        installLogs = [...installLogs, 'Connection successful!'];
        installLogs = [...installLogs, `Server message: ${data.message}`];
        if (data.clients !== undefined) {
          installLogs = [...installLogs, `Connected clients: ${data.clients}`];
        }
      } else {
        throw new Error(data.message || 'Server returned unsuccessful response');
      }
    } catch (error) {
      connectionStatus = 'disconnected';
      
      let errorMessage = 'Connection failed.';
      if (error.name === 'TypeError' && error.message.includes('fetch')) {
        errorMessage = 'Could not reach the server. Make sure the server is running and the address is correct.';
      } else if (error.name === 'TimeoutError') {
        errorMessage = 'Connection timed out. The server may be offline or the address may be incorrect.';
      } else if (error.message) {
        errorMessage = `Connection failed: ${error.message}`;
      }
      
      installLogs = [...installLogs, errorMessage];
      installLogs = [...installLogs, 'Please check the server address and try again.'];
    }
  }
  
  async function saveClientConfiguration() {
    try {
      installing = true;
      installLogs = [];
      installProgress = 0;
      installSpeed = 'Starting...';
    
      // Register event handlers for installation progress
      setupInstallationListeners();
      
      // Add initial log message
      installLogs = [...installLogs, 'Starting client setup...'];
      
      // First, register with the management server
      installLogs = [...installLogs, 'Registering with management server...'];
      const clientId = `client-${Date.now()}-${Math.random().toString(36).substr(2, 9)}`;
      const clientName = `Client-${new Date().toLocaleTimeString()}`;
      
      try {
        const registrationUrl = `http://${serverIp}:${serverPort}/api/client/register`;
        const registrationResponse = await fetch(registrationUrl, {
          method: 'POST',
          headers: {
            'Content-Type': 'application/json'
          },
          body: JSON.stringify({
            clientId: clientId,
            name: clientName
          }),
          signal: AbortSignal.timeout(10000)
        });
        
        if (!registrationResponse.ok) {
          throw new Error(`Registration failed: ${registrationResponse.status}`);
        }
        
        const registrationData = await registrationResponse.json();
        if (!registrationData.success) {
          throw new Error(registrationData.error || 'Registration failed');
        }
        
        installLogs = [...installLogs, `Successfully registered as: ${clientName}`];
        installLogs = [...installLogs, `Client ID: ${clientId}`];
        if (registrationData.token) {
          installLogs = [...installLogs, `Session token received`];
        }
      } catch (regError) {
        installLogs = [...installLogs, `Registration failed: ${regError.message}`];
        installLogs = [...installLogs, 'Continuing with setup anyway...'];
      }
    
      // Save client configuration
      installLogs = [...installLogs, 'Saving client configuration...'];
      await window.electron.invoke('save-client-config', {
        path,
        serverIp,
        serverPort,
        clientId,
        clientName
      });
      
      // For now, we're just setting up the connection
      // In future updates, we'll implement:
      // 1. Download Minecraft client
      // 2. Download Fabric (matching server)
      // 3. Download required mods from server
      
      // Complete setup
      installLogs = [...installLogs, 'Client setup completed successfully!'];
      installing = false;
      dispatchSetupComplete();
    } catch (err) {
      installing = false;
      installLogs = [...installLogs, `Error: ${err.message || 'Unknown error during setup'}`];
    }
  }
  
  function setupInstallationListeners() {
    // Remove any existing listeners first to prevent duplicates
    window.electron.removeAllListeners('minecraft-client-progress');
    window.electron.removeAllListeners('fabric-install-progress');
    window.electron.removeAllListeners('install-log');
    
    // Add new listeners
    window.electron.on('minecraft-client-progress', (data) => {
      if (data && typeof data === 'object') {
        installProgress = data.percent || 0;
        installSpeed = data.speed || '0 MB/s';
      }
    });
    
    window.electron.on('fabric-install-progress', (data) => {
      if (data && typeof data === 'object') {
        installProgress = data.percent || 0;
        installSpeed = data.speed || '0 MB/s';
      }
    });
    
    window.electron.on('install-log', (line) => {
      if (line && typeof line === 'string') {
        installLogs = [...installLogs, line];
      }
    });
  }
  
  function dispatchSetupComplete() {
    // Make sure path is not empty
    if (!path || path.trim() === '') {
      return;
    }
    
    // Use a setTimeout to ensure the event is dispatched after the current execution
    setTimeout(() => {
      dispatch('setup-complete', { 
        path, 
        serverIp,
        serverPort
      });
    }, 0);
  }
  
  onMount(() => {
    // Setup listeners on mount to catch any delayed events
    setupInstallationListeners();
    
    // Clean up event listeners when component is unmounted
    return () => {
      window.electron.removeAllListeners('minecraft-client-progress');
      window.electron.removeAllListeners('fabric-install-progress');
      window.electron.removeAllListeners('install-log');
    };
  });
</script>

<div class="setup-wizard">
  {#if step === 'chooseFolder'}
    <h1>Set up Minecraft Client</h1>
    <p>Select a folder to store your Minecraft client files</p>
    <button class="action-button large-button" on:click={selectFolder}>
      📁 Choose Folder
    </button>
  
  {:else if step === 'configureConnection'}
    <div class="connection-config">
      <h2>Configure Server Connection</h2>
      <div class="form-group">
        <label for="server-ip">Server Address</label>
        <input 
          type="text" 
          id="server-ip" 
          bind:value={serverIp} 
          on:input={onIpChange}
          placeholder="Enter server IP or hostname"
        />
      </div>
      
      <div class="form-group">
        <label for="server-port">Server Port</label>
        <input 
          type="text" 
          id="server-port" 
          bind:value={serverPort} 
          on:input={onIpChange}
          placeholder="8080"
        />
      </div>
      
      <div class="button-group">
        <button 
          class="test-button" 
          on:click={testConnection}
          disabled={!ipValid || connectionStatus === 'connecting'}
        >
          {#if connectionStatus === 'connecting'}
            Testing Connection...
          {:else if connectionStatus === 'connected'}
            ✓ Connection Successful
          {:else}
            Test Connection
          {/if}
        </button>
        
        <button 
          class="action-button" 
          disabled={!ipValid || installing || connectionStatus !== 'connected'} 
          on:click={saveClientConfiguration}
        >
          {installing ? 'Setting Up Client...' : 'Save & Continue'}
        </button>
      </div>
      
      {#if installing}
        <div class="installation-progress">
          <div class="progress-bar">
            <div class="progress-fill" style="width: {installProgress}%"></div>
          </div>
          <p class="progress-text">Progress: {installProgress}% ({installSpeed})</p>
            <div class="install-logs">
            <h3>Setup Logs</h3>
            <div class="logs-container">
              {#each installLogs as log, index (index)}
                <p>{log}</p>
              {/each}
              <!-- Auto-scroll to bottom -->
              <div class="auto-scroll"></div>
            </div>
          </div>
        </div>
      {:else if installLogs.length > 0}        <div class="install-logs">
          <h3>Connection Logs</h3>
          <div class="logs-container">
            {#each installLogs as log, index (index)}
              <p>{log}</p>
            {/each}
            <!-- Auto-scroll to bottom -->
            <div class="auto-scroll"></div>
          </div>
        </div>
      {/if}
    </div>
  {/if}
</div>

<style>
  .setup-wizard {
    display: flex;
    flex-direction: column;
    align-items: center;
    justify-content: center;
    max-width: 800px;
    width: 100%;
    margin: 0 auto;
  }
  
  h1, h2, h3 {
    color: white;
    text-align: center;
    margin-bottom: 1.5rem;
  }
  
  p {
    text-align: center;
    margin-bottom: 2rem;
    color: #d1d5db;
  }
  
  .connection-config {
    display: flex;
    flex-direction: column;
    align-items: center;
    width: 100%;
    max-width: 500px;
  }
  
  .form-group {
    width: 100%;
    margin-bottom: 1.5rem;
  }
  
  label {
    display: block;
    margin-bottom: 0.5rem;
    color: #e2e8f0;
    font-weight: 500;
  }
  
  input {
    width: 100%;
    padding: 0.75rem;
    background-color: #2d3748;
    color: white;
    border: 1px solid #4b5563;
    border-radius: 4px;
    font-size: 1rem;
  }
  
  input:focus {
    outline: none;
    border-color: #3b82f6;
  }
  
  .button-group {
    display: flex;
    flex-direction: column;
    width: 100%;
    gap: 1rem;
    margin-bottom: 1.5rem;
  }
  
  .action-button {
    background-color: #3b82f6;
    color: white;
    border: none;
    border-radius: 4px;
    padding: 0.75rem 2rem;
    font-size: 1rem;
    cursor: pointer;
    transition: background-color 0.2s;
    width: 100%;
  }
  
  .large-button {
    font-size: 1.25rem;
    padding: 1rem 2.5rem;
    margin-bottom: 1.5rem;
  }
  
  .test-button {
    background-color: #10b981;
    color: white;
    border: none;
    border-radius: 4px;
    padding: 0.75rem 2rem;
    font-size: 1rem;
    cursor: pointer;
    transition: background-color 0.2s;
    width: 100%;
  }
  
  .test-button:disabled {
    background-color: #4b5563;
    cursor: not-allowed;
  }
  
  .action-button:hover:not(:disabled) {
    background-color: #2563eb;
  }
  
  .test-button:hover:not(:disabled) {
    background-color: #059669;
  }
  
  .action-button:disabled {
    background-color: #4b5563;
    cursor: not-allowed;
  }
  
  .installation-progress {
    width: 100%;
    margin-top: 1.5rem;
  }
  
  .progress-bar {
    width: 100%;
    height: 0.75rem;
    background-color: #1f2937;
    border-radius: 0.375rem;
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
  }
  
  .install-logs {
    margin-top: 1.5rem;
    width: 100%;
  }
  
  .logs-container {
    background-color: #1f2937;
    border-radius: 4px;
    padding: 1rem;
    max-height: 200px;
    overflow-y: auto;
    font-family: monospace;
    font-size: 0.875rem;
    color: #d1d5db;
    position: relative;
  }
  
  .logs-container p {
    margin: 0.25rem 0;
    text-align: left;
  }
  
  .auto-scroll {
    float: left;
    clear: both;
  }
</style> 