<!-- @ts-ignore -->
<script>
  /// <reference path="../../electron.d.ts" />
  import { createEventDispatcher, onMount } from 'svelte';
  
  // Event dispatcher to communicate with parent component
  const dispatch = createEventDispatcher();
  
  // State variables
  let path = '';
  let inviteLink = '';
  let serverIp = '';
  let serverPort = '8080'; // Default management server port
  let serverProtocol = 'https';
  let inviteSecret = '';
  let managementCertFingerprint = '';
  let installing = false;
  let installProgress = 0;
  let installSpeed = '0 MB/s';
  let installLogs = [];
  let sessionToken = '';
  let step = 'chooseFolder'; // chooseFolder → configureConnection → done
  let inviteValid = false;
  let inviteError = '';
  let connectionStatus = 'disconnected'; // disconnected, connecting, connected
  
  // Functions
  async function selectFolder() {
    try {
      const result = await window.electron.invoke('select-folder', { instanceType: 'client' });
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
  
  function isValidIpv4(host) {
    const ipv4Regex = /^(25[0-5]|2[0-4]\d|1\d\d|[1-9]?\d)(\.(25[0-5]|2[0-4]\d|1\d\d|[1-9]?\d)){3}$/;
    return ipv4Regex.test(host);
  }

  function isValidIpv6(host) {
    if (!host || !host.includes(':')) return false;
    return /^[0-9a-fA-F:]+$/.test(host);
  }

  function validateIp(ip) {
    // Matches IPv4, IPv6, or hostname
    const hostRegex = /^(([a-zA-Z0-9]|[a-zA-Z0-9][a-zA-Z0-9\-]*[a-zA-Z0-9])\.)*([A-Za-z0-9]|[A-Za-z0-9][A-Za-z0-9\-]*[A-Za-z0-9])$/;
    return hostRegex.test(ip) || isValidIpv4(ip) || isValidIpv6(ip);
  }

  function formatHostForUrl(host) {
    if (isValidIpv6(host) && !host.startsWith('[')) {
      return `[${host}]`;
    }
    return host;
  }
  
  function validatePort(port) {
    const portNum = parseInt(port, 10);
    return !isNaN(portNum) && portNum >= 1 && portNum <= 65535;
  }

  function parseInviteLink(value) {
    const trimmed = (value || '').trim();
    if (!trimmed) return { ok: false, error: 'Invite link is required.' };

    let parsed;
    try {
      if (/^[a-zA-Z][a-zA-Z0-9+.-]*:\/\//.test(trimmed)) {
        parsed = new URL(trimmed);
      } else {
        parsed = new URL(`https://${trimmed}`);
      }
    } catch {
      return { ok: false, error: 'Invalid invite link format.' };
    }

    let protocol = (parsed.protocol || '').replace(':', '').toLowerCase();
    if (protocol === 'mccore' || protocol === 'minecraft-core' || protocol === 'mc') {
      protocol = 'https';
    }
    if (protocol !== 'http' && protocol !== 'https') {
      protocol = 'https';
    }

    const host = parsed.hostname || '';
    const port = parsed.port || '8080';
    const secret = parsed.searchParams.get('secret') || parsed.searchParams.get('s') || '';
    const fingerprint = parsed.searchParams.get('fp') || parsed.searchParams.get('fingerprint') || '';

    if (!host || !validateIp(host)) {
      return { ok: false, error: 'Invite link host is invalid.' };
    }
    if (!validatePort(port)) {
      return { ok: false, error: 'Invite link port is invalid.' };
    }
    if (!secret) {
      return { ok: false, error: 'Invite link is missing the secret.' };
    }

    return { ok: true, host, port, protocol, secret, fingerprint };
  }
  
  function onInviteLinkChange() {
    inviteError = '';
    inviteValid = false;
    serverIp = '';
    serverPort = '8080';
    serverProtocol = 'https';
    inviteSecret = '';
    managementCertFingerprint = '';

    const parsed = parseInviteLink(inviteLink);
    if (!parsed.ok) {
      inviteError = parsed.error;
      return;
    }
    serverIp = parsed.host;
    serverPort = parsed.port;
    serverProtocol = parsed.protocol;
    inviteSecret = parsed.secret;
    managementCertFingerprint = parsed.fingerprint || '';
    inviteValid = true;
  }
  
  async function testConnection() {
    if (!inviteValid) return;
    
    connectionStatus = 'connecting';
    installLogs = [...installLogs, `Testing connection to ${serverIp}:${serverPort}...`];
    
    try {
      try {
        await window.electron.invoke('cache-management-cert-pin', {
          host: serverIp,
          port: serverPort,
          fingerprint: managementCertFingerprint || ''
        });
      } catch {
        // ignore pin caching failures during connection test
      }

      // Try to connect to the management server
      const managementUrl = `${serverProtocol}://${formatHostForUrl(serverIp)}:${serverPort}/api/test`;
      
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
        const registrationUrl = `${serverProtocol}://${formatHostForUrl(serverIp)}:${serverPort}/api/client/register`;
        const registrationResponse = await fetch(registrationUrl, {
          method: 'POST',
          headers: {
            'Content-Type': 'application/json'
          },
          body: JSON.stringify({
            clientId: clientId,
            name: clientName,
            secret: inviteSecret
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
          sessionToken = registrationData.token;
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
        clientName,
        sessionToken,
        serverProtocol,
        inviteSecret,
        managementCertFingerprint
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
        serverPort,
        serverProtocol,
        inviteSecret,
        managementCertFingerprint
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
        <label for="invite-link">Invite Link</label>
        <input 
          type="text" 
          id="invite-link" 
          bind:value={inviteLink} 
          on:input={onInviteLinkChange}
          placeholder="https://host:port/?secret=..."
        />
        {#if inviteError}
          <small class="input-error">{inviteError}</small>
        {/if}
      </div>
      
      <div class="button-group">
        <button 
          class="test-button" 
          on:click={testConnection}
          disabled={!inviteValid || connectionStatus === 'connecting'}
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
          disabled={!inviteValid || installing || connectionStatus !== 'connected'} 
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

  .input-error {
    display: block;
    margin-top: 0.35rem;
    color: #f87171;
    font-size: 0.85rem;
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
