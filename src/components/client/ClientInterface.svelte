<script>
  import { onMount, onDestroy } from 'svelte';
  import ConfirmationDialog from '../common/ConfirmationDialog.svelte';
  import ClientModManager from './ClientModManager.svelte';
  import { errorMessage, successMessage } from '../../stores/modStore.js';
  import { createEventDispatcher } from 'svelte';
  
  // Props
  export let instance = {
    serverIp: '',
    serverPort: '8080',  // Management server port, not Minecraft port
    path: '',
    id: '',
    name: '',
    type: 'client'
  }; // Client instance with serverIp, serverPort, path
  
  // Create event dispatcher
  const dispatch = createEventDispatcher();
  
  // Client state management
  let connectionStatus = 'disconnected';     // disconnected, connecting, connected (to management server)
  let managementServerStatus = 'unknown';    // unknown, running, stopped (management server status)
  let minecraftServerStatus = 'unknown';     // unknown, running, stopped (minecraft server status)
  let downloadStatus = 'ready';               // ready, downloading, completed, failed
  let clientSyncStatus = 'ready';            // ready, checking, needed, downloading, failed (for client files)
  let authStatus = 'unknown';                // unknown, checking, authenticated, needs-auth
  let launchStatus = 'ready';               // ready, launching, running, error
  
  // Progress tracking
  let downloadProgress = 0;
  let downloadSpeed = '0 MB/s';
  let currentDownloadFile = '';
  let fileProgress = 0;
  let downloadedBytes = 0;
  let totalBytes = 0;
  let clientDownloadProgress = { type: '', task: '', total: 0 };
  let clientSyncInfo = null;
  let isChecking = false;
  let lastCheck = null;
  
  // Server information
  let serverInfo = null;
  let requiredMods = [];
  let modSyncStatus = null;
  
  // Authentication information
  let authData = null;
  let username = '';
  
  // Launch progress
  let launchProgress = { type: '', task: '', total: 0 };
  
  // Connection check interval
  let connectionCheckInterval;
  let statusCheckInterval;
  
  // Active tab tracking
  let activeTab = 'play';
  const tabs = ['play', 'mods', 'settings'];
  
  // Settings
  let deleteFiles = false;
  let showDeleteConfirmation = false;
  
  // Track download states more precisely
  let isDownloadingClient = false;
  let isDownloadingMods = false;
  let isCheckingSync = false;
  let lastSyncCheck = null;
  
  // UI state variables
  let clientSync = { synchronized: false, reason: '' };
  let modSync = { synchronized: false, reason: '' };
  let downloadButtonText = 'Check Setup';
  
  // Memory/RAM settings
  let maxMemory = 2; // Default 2GB (in GB instead of MB)
  let systemMemoryGB = 8; // Will be detected from system
  
  // Launch progress tracking
  let isLaunching = false;
  let launchProgressText = '';
  
  // Console spam reduction variables
  let previousServerInfo = null;
  let lastSyncKey = null;
  
  // Connect to the Management Server (port 8080)
  async function connectToServer() {
    if (!instance || !instance.serverIp || !instance.serverPort) {
      console.error('Server address not configured');
      connectionStatus = 'disconnected';
      return;
    }
    
    connectionStatus = 'connecting';
    
    try {
      const managementUrl = `http://${instance.serverIp}:${instance.serverPort}/api/test`;
      console.log(`[Client] Testing connection to management server: ${managementUrl}`);
      
      const response = await fetch(managementUrl, {
        method: 'GET',
        headers: {
          'Content-Type': 'application/json'
        },
        signal: AbortSignal.timeout(5000) // 5 second timeout
      });
      
      if (!response.ok) {
        throw new Error(`Management server responded with ${response.status}`);
      }
      
      const data = await response.json();
      if (data.success) {
        connectionStatus = 'connected';
        console.log('[Client] Successfully connected to management server');
        
        // Register with the server
        await registerWithServer();
        
        // Check server status and get server info
        await checkServerStatus();
        await getServerInfo();
        await checkAuthentication();
        
      } else {
        throw new Error('Management server returned unsuccessful response');
      }
    } catch (err) {
      console.error('[Client] Failed to connect to management server:', err);
      connectionStatus = 'disconnected';
      managementServerStatus = 'unknown';
      minecraftServerStatus = 'unknown';
    }
  }
  
  // Register with the management server
  async function registerWithServer() {
    try {
      const clientId = instance.clientId || `client-${Date.now()}`;
      const clientName = instance.clientName || instance.name || 'Minecraft Client';
      
      const registerUrl = `http://${instance.serverIp}:${instance.serverPort}/api/client/register`;
      const response = await fetch(registerUrl, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json'
        },
        body: JSON.stringify({
          clientId,
          name: clientName
        })
      });
      
      if (response.ok) {
        const data = await response.json();
        console.log('[Client] Successfully registered with management server');
        
        // Update instance with client info if needed
        if (!instance.clientId) {
          instance.clientId = clientId;
          instance.clientName = clientName;
          
          // Save the updated client configuration
          await window.electron.invoke('save-client-config', {
            path: instance.path,
            serverIp: instance.serverIp,
            serverPort: instance.serverPort,
            clientId,
            clientName
          });
        }
      }
    } catch (err) {
      console.warn('[Client] Failed to register with server:', err);
    }
  }
  
  // Check both management server and minecraft server status
  async function checkServerStatus() {
    if (connectionStatus !== 'connected') {
      managementServerStatus = 'unknown';
      minecraftServerStatus = 'unknown';
      return;
    }
    
    isChecking = true;
    
    try {
      // Check management server status
      const managementUrl = `http://${instance.serverIp}:${instance.serverPort}/api/test`;
      const managementResponse = await fetch(managementUrl, {
        method: 'GET',
        signal: AbortSignal.timeout(3000)
      });
      
      if (managementResponse.ok) {
        managementServerStatus = 'running';
        
        // Get server info to check minecraft server status
        await getServerInfo();
      } else {
        throw new Error('Management server not responding');
      }
      
      lastCheck = new Date();
    } catch (err) {
      console.error('[Client] Failed to check server status:', err);
      connectionStatus = 'disconnected';
      managementServerStatus = 'unknown';
      minecraftServerStatus = 'unknown';
    }
    
    isChecking = false;
  }
  
  // Get server information including Minecraft version and required mods
  async function getServerInfo() {
    try {
      const serverInfoUrl = `http://${instance.serverIp}:${instance.serverPort}/api/server/info`;
      const response = await fetch(serverInfoUrl, {
        method: 'GET',
        signal: AbortSignal.timeout(5000)
      });
      
      if (response.ok) {
        serverInfo = await response.json();
        if (serverInfo.success) {
          minecraftServerStatus = serverInfo.minecraftServerStatus || 'unknown';
          requiredMods = serverInfo.requiredMods || [];
          
                  // Track server info changes for UI updates only (no console spam)
        if (!previousServerInfo || 
            previousServerInfo.minecraftVersion !== serverInfo.minecraftVersion || 
            (previousServerInfo.requiredMods?.length || 0) !== requiredMods.length) {
          previousServerInfo = { minecraftVersion: serverInfo.minecraftVersion, requiredMods };
        }
          
          // Check mod synchronization status
          await checkModSynchronization();
          
          // Check client synchronization status
          await checkClientSynchronization();
        }
      }
    } catch (err) {
      console.warn('[Client] Could not get server info:', err);
      minecraftServerStatus = 'unknown';
    }
  }
  
  // Check if client mods are synchronized with server
  async function checkModSynchronization() {
    if (isDownloadingMods || isDownloadingClient) {
      console.log('[Client] Skipping mod sync check - downloads in progress');
      return;
    }
    
    if (!instance.path || !requiredMods || requiredMods.length === 0) {
      downloadStatus = 'ready';
      return;
    }
    
    downloadStatus = 'checking';
    
    try {
      const result = await window.electron.invoke('minecraft-check-mods', {
        clientPath: instance.path,
        requiredMods
      });
      
      if (result.success) {
        modSyncStatus = result;
        
        if (result.synchronized) {
          downloadStatus = 'ready';
        } else {
          downloadStatus = 'needed';
        }
        
        console.log(`[Client] Mod sync status: ${result.totalPresent}/${result.totalRequired} mods present, ${result.needsDownload} need download`);
      } else {
        downloadStatus = 'ready'; // Assume ready if check fails
      }
    } catch (err) {
      console.error('[Client] Error checking mod synchronization:', err);
      downloadStatus = 'ready';
    }
  }
  
  // Check if Minecraft client files are synchronized
  async function checkClientSynchronization() {
    if (isDownloadingMods || isDownloadingClient) {
      console.log('[Client] Skipping client sync check - downloads in progress');
      return;
    }
    
    if (!instance.path || !serverInfo?.minecraftVersion) {
      console.log('[Client] Cannot check client sync - missing path or version');
      clientSyncStatus = 'ready';
      return;
    }
    
    // Only log when client sync actually changes, not every check
    const currentSyncKey = `${serverInfo.minecraftVersion}-${instance.path}`;
    if (lastSyncKey !== currentSyncKey) {
      // Remove unnecessary log spam - sync checks are routine
      lastSyncKey = currentSyncKey;
    }
    clientSyncStatus = 'checking';
    
    try {
      const result = await window.electron.invoke('minecraft-check-client', {
        clientPath: instance.path,
        minecraftVersion: serverInfo.minecraftVersion,
        requiredMods: requiredMods || [],
        serverInfo: serverInfo
      });
      
      console.log('[Client] Check client result:', result);
      
      if (result.success) {
        clientSyncInfo = result;
        
        if (result.synchronized) {
          clientSyncStatus = 'ready';
          console.log(`[Client] Client files are ready: ${result.reason}`);
        } else {
          clientSyncStatus = 'needed';
          console.log(`[Client] Client files needed: ${result.reason}`);
        }
      } else {
        console.error('[Client] Error checking client:', result.error);
        clientSyncStatus = 'ready'; // Assume ready if check fails
      }
    } catch (err) {
      console.error('[Client] Error checking client synchronization:', err);
      clientSyncStatus = 'ready';
    }
  }
  
  // Check authentication status
  async function checkAuthentication() {
    console.log('[Client] checkAuthentication() called, current authStatus:', authStatus);
    
    if (!instance.path) {
      console.log('[Client] No instance path, setting authStatus to needs-auth');
      authStatus = 'needs-auth';
      return;
    }
    
    // Only set to checking if we're not already authenticated
    // and not currently authenticating
    if (authStatus !== 'authenticated' && authStatus !== 'authenticating') {
      console.log('[Client] Setting authStatus to checking');
      authStatus = 'checking';
    }
    
    try {
      console.log('[Client] About to call minecraft-load-auth IPC...');
      
      // Add timeout to prevent getting stuck in checking state
      const authTimeout = setTimeout(() => {
        console.warn('[Client] Authentication check timed out');
        if (authStatus === 'checking') {
          authStatus = 'needs-auth';
        }
      }, 5000);
      
      const result = await window.electron.invoke('minecraft-load-auth', {
        clientPath: instance.path
      });
      
      console.log('[Client] minecraft-load-auth result:', result);
      clearTimeout(authTimeout);
      
      if (result.success) {
        authStatus = 'authenticated';
        username = result.username;
        authData = { username: result.username, uuid: result.uuid };
        
        if (result.needsRefresh) {
          console.log('[Client] Authentication may need refresh');
        }
        
        console.log(`[Client] Authentication loaded: ${result.username}`);
      } else {
        // Only set to needs-auth if we're not currently authenticating
        if (authStatus !== 'authenticating') {
          authStatus = 'needs-auth';
          username = '';
          authData = null;
        }
        console.log('[Client] No valid authentication found');
      }
    } catch (err) {
      console.error('[Client] Error checking authentication:', err);
      // Only set to needs-auth if we're not currently authenticating
      if (authStatus !== 'authenticating') {
        authStatus = 'needs-auth';
        username = '';
        authData = null;
      }
    }
  }
  
  // Authenticate with Microsoft
  async function authenticateWithMicrosoft() {
    console.log('[Client] authenticateWithMicrosoft() called');
    
    // Check if already authenticated
    if (authStatus === 'authenticated' && username && authData) {
      console.log('[Client] User is already authenticated, skipping authentication');
      successMessage.set(`Already authenticated as ${username}`);
      setTimeout(() => successMessage.set(''), 3000);
      return;
    }
    
    console.log('[Client] Starting Microsoft authentication...');
    authStatus = 'authenticating';
    
    // Add a timeout to prevent getting stuck
    const authTimeout = setTimeout(async () => {
      console.log('[Client] Authentication timeout, checking if auth actually succeeded...');
      
      // Only check if we're still in authenticating state
      if (authStatus === 'authenticating') {
        await checkAuthentication();
        
        // If we have username/authData after checking, the auth actually worked
        if (username && authData) {
          console.log('[Client] Authentication actually succeeded despite timeout');
          authStatus = 'authenticated';
          successMessage.set(`Authentication recovered for ${username}`);
          setTimeout(() => successMessage.set(''), 3000);
        } else {
          console.log('[Client] Authentication actually failed - resetting to needs-auth');
          authStatus = 'needs-auth';
          errorMessage.set('Authentication timed out. Please try again.');
          setTimeout(() => errorMessage.set(''), 5000);
        }
      }
    }, 15000); // 15 second timeout
    
    try {
      console.log('[Client] About to call minecraft-auth IPC...');
      const result = await window.electron.invoke('minecraft-auth', {
        clientPath: instance.path
      });
      console.log('[Client] minecraft-auth result:', result);
      
      // Clear the timeout since we got a response
      clearTimeout(authTimeout);
      
      if (result.success) {
        console.log(`[Client] Authentication successful: ${result.username}`);
        
        // Update authentication state
        authStatus = 'authenticated';
        username = result.username;
        authData = { username: result.username, uuid: result.uuid };
        
        // Save authentication data
        await window.electron.invoke('minecraft-save-auth', {
          clientPath: instance.path
        });
        
        // Force re-check server status and synchronization 
        // but don't call checkAuthentication() since we already have the auth data
        await checkServerStatus();
        await getServerInfo();
        await checkModSynchronization();
        await checkClientSynchronization();
        
        successMessage.set(`Successfully authenticated as ${result.username}`);
        setTimeout(() => successMessage.set(''), 3000);
        
      } else {
        console.error('[Client] Authentication failed:', result.error);
        authStatus = 'needs-auth';
        errorMessage.set('Authentication failed: ' + result.error);
        setTimeout(() => errorMessage.set(''), 5000);
      }
    } catch (err) {
      // Clear the timeout since we got an error
      clearTimeout(authTimeout);
      
      console.error('[Client] Authentication error:', err);
      
      // Check if auth actually succeeded despite the error
      const savedAuthStatus = authStatus;
      await checkAuthentication();
      if (username && authData && authStatus === 'authenticated') {
        console.log('[Client] Authentication succeeded despite error');
        successMessage.set(`Authentication completed for ${username}`);
        setTimeout(() => successMessage.set(''), 3000);
      } else {
        authStatus = 'needs-auth';
        errorMessage.set('Authentication error: ' + err.message);
        setTimeout(() => errorMessage.set(''), 5000);
      }
    }
  }
  
  // Download required mods with debug wrapper
  async function onDownloadModsClick() {
    console.log('[Client] Download Mods button clicked!');
    console.log('[Client] Button click timestamp:', new Date().toISOString());
    console.log('[Client] Current button state:', { downloadStatus, requiredModsLength: requiredMods?.length });
    
    // Show immediate loading state
    downloadStatus = 'downloading';
    downloadProgress = 0;
    
    try {
      await downloadMods();
    } catch (error) {
      console.error('[Client] Error in download mods click handler:', error);
      errorMessage.set(`Download error: ${error.message}`);
      setTimeout(() => errorMessage.set(''), 5000);
      downloadStatus = 'needed'; // Reset status on error
    }
  }
  
  // Download required mods
  async function downloadMods() {
    console.log('[Client] downloadMods() called');
    console.log('[Client] Current state:', {
      requiredMods: requiredMods,
      requiredModsLength: requiredMods ? requiredMods.length : 'undefined',
      downloadStatus: downloadStatus,
      instancePath: instance?.path,
      serverIp: instance?.serverIp,
      serverPort: instance?.serverPort
    });
    
    // Validate required parameters
    if (!instance?.path) {
      console.error('[Client] No instance path provided');
      errorMessage.set('No client path configured');
      setTimeout(() => errorMessage.set(''), 5000);
      return;
    }
    
    if (!requiredMods || requiredMods.length === 0) {
      console.log('[Client] No required mods, setting downloadStatus to ready');
      downloadStatus = 'ready';
      return;
    }
    
    // Set downloading state
    isDownloadingMods = true;
    
    // Validate that each mod has necessary properties
    const invalidMods = requiredMods.filter(mod => !mod.fileName || !mod.downloadUrl);
    if (invalidMods.length > 0) {
      console.error('[Client] Invalid mods found:', invalidMods);
      errorMessage.set(`Invalid mod data: ${invalidMods.length} mods missing required properties`);
      setTimeout(() => errorMessage.set(''), 5000);
      isDownloadingMods = false;
      return;
    }
    
    console.log('[Client] Starting mod download process...');
    console.log('[Client] Required mods details:', requiredMods.map(m => ({
      fileName: m.fileName,
      downloadUrl: m.downloadUrl,
      hasChecksum: !!m.checksum,
      size: m.size
    })));
    
    // Reset download state
    downloadProgress = 0;
    currentDownloadFile = '';
    fileProgress = 0;
    downloadedBytes = 0;
    totalBytes = 0;
    
    // Set downloading status to show immediate feedback
    downloadStatus = 'downloading';
    
    try {
      console.log('[Client] Calling minecraft-download-mods IPC...');
      const result = await window.electron.invoke('minecraft-download-mods', {
        clientPath: instance.path,
        requiredMods,
        serverInfo: {
          serverIp: instance.serverIp,
          serverPort: instance.serverPort
        }
      });
      
      console.log('[Client] Download result:', result);
      
      if (result.success) {
        downloadStatus = 'ready';
        downloadProgress = 100;
        
        let message = `Successfully processed ${result.downloaded + result.skipped} mods`;
        if (result.downloaded > 0) {
          message += ` (${result.downloaded} downloaded`;
          if (result.skipped > 0) {
            message += `, ${result.skipped} already present)`;
          } else {
            message += ')';
          }
        } else if (result.skipped > 0) {
          message += ` (all already present)`;
        }
        
        successMessage.set(message);
        setTimeout(() => successMessage.set(''), 5000);
        
        // Re-check mod synchronization after download
        await checkModSynchronization();
      } else {
        downloadStatus = 'needed';
        let failureMsg = 'Failed to download mods';
        
        if (result.failures && result.failures.length > 0) {
          failureMsg = `Failed to download ${result.failures.length} mods`;
          console.error('[Client] Download failures:', result.failures);
          
          // Show details of first few failures
          const firstFailures = result.failures.slice(0, 3);
          const failureDetails = firstFailures.map(f => `${f.fileName}: ${f.error}`).join('; ');
          if (result.failures.length > 3) {
            failureMsg += ` (${failureDetails}... and ${result.failures.length - 3} more)`;
          } else {
            failureMsg += ` (${failureDetails})`;
          }
        } else if (result.error) {
          failureMsg += `: ${result.error}`;
        }
        
        errorMessage.set(failureMsg);
        setTimeout(() => errorMessage.set(''), 8000);
      }
    } catch (err) {
      console.error('[Client] Error downloading mods:', err);
      downloadStatus = 'needed';
      
      let errorMsg = 'Error downloading mods';
      if (err.message) {
        if (err.message.includes('ENOTFOUND')) {
          errorMsg += ': Cannot connect to server (network error)';
        } else if (err.message.includes('ECONNREFUSED')) {
          errorMsg += ': Server connection refused';
        } else {
          errorMsg += `: ${err.message}`;
        }
      }
      
      errorMessage.set(errorMsg);
      setTimeout(() => errorMessage.set(''), 8000);
    } finally {
      isDownloadingMods = false;
      // Trigger a sync check after download completes
      setTimeout(() => checkSyncStatus(), 1000);
    }
  }
  
  // Download Minecraft client files
  async function downloadClient() {
    if (!serverInfo?.minecraftVersion) {
      errorMessage.set('No Minecraft version specified by server');
      setTimeout(() => errorMessage.set(''), 5000);
      return;
    }
    
    console.log(`[Client] Starting client download for Minecraft ${serverInfo.minecraftVersion}...`);
    isDownloadingClient = true;
    clientSyncStatus = 'downloading';
    clientDownloadProgress = { type: 'Preparing', task: 'Starting download...', total: 0 };
    
    try {
      const result = await window.electron.invoke('minecraft-download-client', {
        clientPath: instance.path,
        minecraftVersion: serverInfo.minecraftVersion,
        requiredMods: requiredMods || [],
        serverInfo: {
          ...serverInfo,
          serverIp: instance.serverIp // Add the server IP for server list addition
        }
      });
      
      console.log('[Client] Client download result:', result);
      
      if (result.success) {
        clientSyncStatus = 'ready';
        
        if (result.message) {
          successMessage.set(result.message);
          setTimeout(() => successMessage.set(''), 8000); // Longer timeout for longer message
        } else {
          successMessage.set(`Successfully downloaded Minecraft ${result.version} client files`);
          setTimeout(() => successMessage.set(''), 3000);
        }
        
        // Re-check client synchronization after download
        await checkClientSynchronization();
      } else {
        clientSyncStatus = 'needed';
        errorMessage.set('Failed to download client files: ' + result.error);
        setTimeout(() => errorMessage.set(''), 5000);
      }
    } catch (err) {
      console.error('[Client] Error downloading client files:', err);
      clientSyncStatus = 'needed';
      errorMessage.set('Error downloading client files: ' + err.message);
      setTimeout(() => errorMessage.set(''), 5000);
    } finally {
      isDownloadingClient = false;
      // Trigger a sync check after download completes
      setTimeout(() => checkSyncStatus(), 1000);
    }
  }
  
  // Clear and re-download client files
  async function redownloadClient() {
    if (!serverInfo?.minecraftVersion) {
      errorMessage.set('No Minecraft version specified by server');
      setTimeout(() => errorMessage.set(''), 5000);
      return;
    }
    
    try {
      console.log(`[Client] Clearing and re-downloading client files...`);
      
      // Clear existing client files first
      const clearResult = await window.electron.invoke('minecraft-clear-client', {
        clientPath: instance.path,
        minecraftVersion: serverInfo.minecraftVersion
      });
      
      if (clearResult.success) {
        // Force re-check to show "needed" status
        clientSyncStatus = 'needed';
        
        // Then download fresh files
        await downloadClient();
      } else {
        errorMessage.set('Failed to clear client files: ' + clearResult.error);
        setTimeout(() => errorMessage.set(''), 5000);
      }
      
    } catch (err) {
      console.error('[Client] Error clearing client files:', err);
      errorMessage.set('Error clearing client files: ' + err.message);
      setTimeout(() => errorMessage.set(''), 5000);
    }
  }
  
  // Launch Minecraft client
  async function launchMinecraft() {
    if (authStatus !== 'authenticated') {
      errorMessage.set('Please authenticate with Microsoft first');
      setTimeout(() => errorMessage.set(''), 5000);
      return;
    }
    
    if (minecraftServerStatus !== 'running') {
      errorMessage.set('The Minecraft server is not running. Please wait for the server to start.');
      setTimeout(() => errorMessage.set(''), 5000);
      return;
    }
    
    if (clientSyncStatus === 'needed') {
      errorMessage.set('Minecraft client files need to be downloaded first');
      setTimeout(() => errorMessage.set(''), 5000);
      return;
    }
    
    if (downloadStatus === 'needed') {
      errorMessage.set('Required mods need to be downloaded first');
      setTimeout(() => errorMessage.set(''), 5000);
      return;
    }
    
    isLaunching = true;
    launchStatus = 'launching';
    launchProgressText = 'Preparing to launch Minecraft...';
    launchProgress = { type: 'Preparing', task: 'Initializing launcher...', total: 0 };
    
    try {
      const minecraftPort = serverInfo?.minecraftPort || '25565';
      
      const result = await window.electron.invoke('minecraft-launch', {
        clientPath: instance.path,
        minecraftVersion: serverInfo?.minecraftVersion || '1.20.1',
        serverIp: instance.serverIp,
        serverPort: minecraftPort, // This is the Minecraft game server port, not management port
        requiredMods,
        serverInfo,
        maxMemory: Math.round(maxMemory * 1024) // Convert GB to MB for launcher
      });
      
      if (result.success) {
        launchStatus = 'running';
        isLaunching = false;
        successMessage.set('Minecraft launched successfully!');
        setTimeout(() => successMessage.set(''), 3000);
      } else {
        launchStatus = 'error';
        isLaunching = false;
        
        // Handle specific error types
        let errorMsg = result.error || 'Unknown launch error';
        
        if (errorMsg.includes('Authentication expired') || errorMsg.includes('authserver.mojang.com')) {
          errorMsg = 'Your Microsoft authentication has expired. Please click "🔄 Re-authenticate" in Settings and try again.';
          // Also update auth status
          authStatus = 'needs-auth';
          username = '';
          authData = null;
        } else if (errorMsg.includes('EMFILE') || errorMsg.includes('too many files')) {
          errorMsg = 'Too many files are open. Please close other applications and try again.';
        } else if (errorMsg.includes('ENOENT') || errorMsg.includes('not found')) {
          errorMsg = 'Minecraft client files may be corrupted. Try re-downloading the client files.';
        } else if (errorMsg.includes('Java') || errorMsg.includes('JVM')) {
          errorMsg = 'Java runtime error. Please ensure you have Java installed.';
        }
        
        errorMessage.set(errorMsg);
        setTimeout(() => errorMessage.set(''), 8000); // Longer timeout for detailed error messages
      }
    } catch (err) {
      console.error('[Client] Launch error:', err);
      launchStatus = 'error';
      isLaunching = false;
      
      let errorMsg = err.message || 'Unknown launch error';
      
      // Handle network errors
      if (errorMsg.includes('ENOTFOUND') || errorMsg.includes('network')) {
        errorMsg = 'Network connection error. Please check your internet connection and try again.';
      } else if (errorMsg.includes('Authentication')) {
        errorMsg = 'Authentication error. Please re-authenticate with Microsoft in Settings.';
        authStatus = 'needs-auth';
        username = '';
        authData = null;
      }
      
      errorMessage.set('Launch error: ' + errorMsg);
      setTimeout(() => errorMessage.set(''), 8000);
    }
  }
  
  // Stop Minecraft if running
  async function stopMinecraft() {
    try {
      console.log('[Client] Stopping Minecraft...');
      isLaunching = false;
      launchStatus = 'ready';
      
      const result = await window.electron.invoke('minecraft-stop');
      console.log('[Client] Stop result:', result);
      
      successMessage.set(result.message || 'Minecraft stopped successfully');
      setTimeout(() => successMessage.set(''), 3000);
    } catch (err) {
      console.error('[Client] Error stopping Minecraft:', err);
      launchStatus = 'ready'; // Reset status anyway
      errorMessage.set('Error stopping Minecraft: ' + err.message);
      setTimeout(() => errorMessage.set(''), 5000);
    }
  }


  
  // Set up launcher event listeners
  function setupLauncherEvents() {
    // Download events
    window.electron.on('launcher-download-start', (data) => {
      downloadStatus = 'downloading';
      downloadProgress = 0;
      console.log(`[Client] Starting download of ${data.total} mods`);
    });
    
    window.electron.on('launcher-download-progress', (data) => {
      downloadProgress = Math.round((data.downloaded / data.total) * 100);
      currentDownloadFile = data.current || '';
      
      // Handle file-level progress if available
      if (data.fileProgress !== undefined) {
        fileProgress = data.fileProgress;
      }
      
      if (data.downloadedBytes && data.totalSize) {
        downloadedBytes = data.downloadedBytes;
        totalBytes = data.totalSize;
        
        // Calculate download speed (rough estimate)
        const mbps = (data.downloadedBytes / (1024 * 1024)).toFixed(1);
        downloadSpeed = `${mbps} MB downloaded`;
      }
      
      // Update status based on progress data
      if (data.status) {
        if (data.status === 'downloading') {
          downloadStatus = 'downloading';
        } else if (data.status === 'completed') {
          downloadStatus = data.downloaded === data.total ? 'ready' : 'downloading';
        } else if (data.status === 'failed') {
          downloadStatus = 'needed'; // Allow retry
        }
      }
      
      console.log(`[Client] Download progress: ${downloadProgress}% (${data.current}) - File: ${fileProgress}%`);
    });
    
    window.electron.on('launcher-download-complete', (data) => {
      downloadStatus = data.success ? 'ready' : 'needed';
      downloadProgress = 100;
      currentDownloadFile = '';
      console.log(`[Client] Download complete: ${data.downloaded} downloaded, ${data.failed} failed`);
    });
    
    // Launch events
    window.electron.on('launcher-launch-start', () => {
      isLaunching = true;
      launchStatus = 'launching';
      launchProgressText = 'Starting launcher...';
      launchProgress = { type: 'Starting', task: 'Preparing to launch...', total: 0 };
    });
    
    window.electron.on('launcher-launch-progress', (data) => {
      launchProgress = data;
      if (data.task) {
        launchProgressText = data.task;
      }
    });
    
    window.electron.on('launcher-launch-success', () => {
      launchStatus = 'running';
      isLaunching = false;
    });
    
    window.electron.on('launcher-launch-error', (error) => {
      launchStatus = 'error';
      isLaunching = false;
      errorMessage.set('Launch failed: ' + error);
      setTimeout(() => errorMessage.set(''), 5000);
    });
    
    window.electron.on('launcher-minecraft-closed', (data) => {
      launchStatus = 'ready';
      console.log(`[Client] Minecraft closed with code: ${data.code}`);
    });
    
    // Auth events
    window.electron.on('launcher-auth-success', (data) => {
      console.log('[Client] Auth success event received:', data);
      
      // Only update if we have valid data and we're not already authenticated with this user
      if (data && data.username && (!username || username !== data.username)) {
        authStatus = 'authenticated';
        username = data.username;
        authData = data;
        
        // Force re-check everything after authentication event
        setTimeout(async () => {
          await checkServerStatus();
          await getServerInfo();
          await checkModSynchronization();
          await checkClientSynchronization();
        }, 100);
      }
    });
    
    window.electron.on('launcher-auth-error', (error) => {
      console.error('[Client] Auth error event received:', error);
      authStatus = 'needs-auth';
      errorMessage.set('Authentication failed: ' + error);
      setTimeout(() => errorMessage.set(''), 5000);
    });
    
    // Client download events
    window.electron.on('launcher-client-download-start', (data) => {
      clientSyncStatus = 'downloading';
      clientDownloadProgress = { type: 'Starting', task: `Downloading Minecraft ${data.version}...`, total: 0 };
      console.log(`[Client] Starting client download for ${data.version}`);
    });
    
    window.electron.on('launcher-client-download-progress', (data) => {
      clientDownloadProgress = data;
      console.log(`[Client] Client download progress: ${data.type} - ${data.task}`);
    });
    
    window.electron.on('launcher-client-download-complete', (data) => {
      console.log('[Client] Client download complete:', data);
      isDownloadingClient = false;
      clientDownloadProgress = { type: 'Complete', task: 'Client download finished', total: 100 };
      clientSyncStatus = 'ready';
      
      if (data.success) {
        successMessage.set(`Client download complete: ${data.message || 'Minecraft client files downloaded successfully'}`);
        setTimeout(() => successMessage.set(''), 5000);
        
        // Refresh both client and mod sync status after client download
        setTimeout(() => {
          checkSyncStatus();
        }, 1000);
      } else {
        errorMessage.set(`Client download failed: ${data.error || 'Unknown error'}`);
        setTimeout(() => errorMessage.set(''), 8000);
      }
      
      console.log(`[Client] Client download complete for ${data.version}`);
    });
    
    window.electron.on('launcher-client-download-error', (data) => {
      clientSyncStatus = 'needed';
      errorMessage.set('Client download failed: ' + data.error);
      setTimeout(() => errorMessage.set(''), 5000);
      console.error(`[Client] Client download error: ${data.error}`);
    });
  }
  
  // Clean up event listeners
  function cleanupLauncherEvents() {
    const events = [
      'launcher-download-start',
      'launcher-download-progress', 
      'launcher-download-complete',
      'launcher-launch-start',
      'launcher-launch-progress',
      'launcher-launch-success',
      'launcher-launch-error',
      'launcher-minecraft-closed',
      'launcher-auth-success',
      'launcher-auth-error',
      'launcher-client-download-start',
      'launcher-client-download-progress',
      'launcher-client-download-complete',
      'launcher-client-download-error'
    ];
    
    events.forEach(event => {
      window.electron.removeAllListeners(event);
    });
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
    
    // Set up periodic server status check (reduced frequency)
    statusCheckInterval = setInterval(() => {
      if (connectionStatus === 'connected') {
        checkServerStatus();
      }
    }, 60000); // Every 60 seconds (reduced frequency)
    
    // Set up periodic launcher status check to detect when Minecraft stops  
    const launcherStatusInterval = setInterval(async () => {
      if (launchStatus === 'running') {
        try {
          const status = await window.electron.invoke('minecraft-get-status');
          if (status && !status.isRunning && !status.isLaunching) {
            console.log('[Client] Detected Minecraft has stopped running');
            launchStatus = 'ready';
          }
        } catch (err) {
          // Remove console spam - errors should only be logged if meaningful
          // (This is just a periodic status check, don't spam on every failure)
        }
      }
    }, 5000); // Every 5 seconds when running
    
    // Store interval for cleanup
    connectionCheckInterval = connectionCheckInterval;
    statusCheckInterval = statusCheckInterval;
    
    // Add launcher status interval to cleanup
    onDestroy(() => {
      clearInterval(launcherStatusInterval);
    });
  }
  
  // Clean up on component unmount
  onDestroy(() => {
    clearInterval(connectionCheckInterval);
    clearInterval(statusCheckInterval);
    cleanupLauncherEvents();
  });
  
  // Force refresh all status checks
  async function forceRefresh() {
    console.log('[Client] Force refreshing all status checks...');
    
    // Reset states to force re-check
    authStatus = 'checking';
    connectionStatus = 'connecting';
    downloadStatus = 'checking';
    clientSyncStatus = 'checking';
    
    try {
      await connectToServer();
      await checkAuthentication();
      await checkServerStatus();
      await getServerInfo();
      await checkModSynchronization();
      await checkClientSynchronization();
    } catch (error) {
      console.error('[Client] Error during force refresh:', error);
    }
  }
  
  // Debug Java installation function removed - no longer needed
  
  onMount(() => {
    // Initialize client functionality
    setupLauncherEvents();
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
  
  // Prevent sync check when downloads are in progress
  async function checkSyncStatus() {
    if (isDownloadingClient || isDownloadingMods || isCheckingSync) {
      console.log('[Client] Skipping sync check - downloads in progress');
      return;
    }
    
    if (!instance?.path || !serverInfo?.minecraftVersion) {
      console.log('[Client] Cannot check sync - missing instance or server info');
      return;
    }
    
    isCheckingSync = true;
    
    try {
      console.log('[Client] Checking sync status...');
      
      const syncResult = await window.electron.invoke('minecraft-check-client-sync', {
        clientPath: instance.path,
        minecraftVersion: serverInfo.minecraftVersion,
        requiredMods: requiredMods || [],
        serverInfo: serverInfo
      });
      
      console.log('[Client] Sync check result:', syncResult);
      lastSyncCheck = Date.now();
      
      if (syncResult.success) {
        clientSync = syncResult.clientSync;
        modSync = syncResult.modSync;
        downloadStatus = syncResult.overallStatus;
        
        // Update download button text
        if (downloadStatus === 'ready') {
          downloadButtonText = 'Launch Game';
        } else if (downloadStatus === 'needs-client') {
          downloadButtonText = 'Download Game Files';
        } else if (downloadStatus === 'needs-mods') {
          downloadButtonText = 'Download Required Mods';
        } else {
          downloadButtonText = 'Setup Required';
        }
      } else {
        console.error('[Client] Sync check failed:', syncResult.error);
        downloadStatus = 'error';
        downloadButtonText = 'Check Failed - Retry';
      }
    } catch (error) {
      console.error('[Client] Error checking sync status:', error);
      downloadStatus = 'error';
      downloadButtonText = 'Check Failed - Retry';
    } finally {
      isCheckingSync = false;
    }
  }
</script>

<div class="client-container">
  <header class="client-header">
    <h1>Minecraft Client</h1>
    <div class="connection-status">
      <!-- Management Server Status -->
      <div class="status-section">
        <span class="status-section-label">Management Server:</span>
        {#if connectionStatus === 'connected'}
          <div class="status-indicator connected" title="Connected to management server">
            <span class="status-dot"></span>
            <span class="status-text">Connected</span>
          </div>
        {:else if connectionStatus === 'connecting'}
          <div class="status-indicator connecting" title="Connecting to management server">
            <span class="status-dot"></span>
            <span class="status-text">Connecting...</span>
          </div>
        {:else}
          <div class="status-indicator disconnected" title="Not connected to management server">
            <span class="status-dot"></span>
            <span class="status-text">Disconnected</span>
          </div>
        {/if}
      </div>
      
      {#if connectionStatus === 'connected'}
        <div class="server-details">
          <span class="server-address">
            <span class="address-label">Management Server:</span>
            {instance?.serverIp || 'Unknown'}:{instance?.serverPort || '8080'}
          </span>
          
          <!-- Minecraft Server Status -->
          <div class="status-section">
            <span class="status-section-label">Minecraft Server:</span>
            {#if minecraftServerStatus === 'running'}
              <div class="status-indicator server-running" title="Minecraft server is running">
                <span class="status-dot"></span>
                <span class="status-text">Running</span>
              </div>
            {:else if minecraftServerStatus === 'stopped'}
              <div class="status-indicator server-stopped" title="Minecraft server is stopped">
                <span class="status-dot"></span>
                <span class="status-text">Stopped</span>
              </div>
            {:else}
              <div class="status-indicator server-unknown" title="Minecraft server status unknown">
                <span class="status-dot"></span>
                <span class="status-text">Status Unknown</span>
              </div>
            {/if}
          </div>
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
          {#if tab === 'play'}
            🎮 Play
          {:else if tab === 'mods'}
            🧩 Mods
          {:else if tab === 'settings'}
            ⚙️ Settings
          {:else}
            {tab[0].toUpperCase() + tab.slice(1)}
          {/if}
        </button>
      {/each}
    </div>
  </header>
  
  <div class="client-content">
    {#if activeTab === 'play'}
      <div class="client-main">
        <div class="client-status">
          {#if connectionStatus !== 'connected'}
            <div class="connection-status-display">
              <h2>Connecting to Server</h2>
              <p>Attempting to connect to the management server...</p>
            </div>
          {:else if authStatus === 'needs-auth'}
            <div class="auth-section">
              <h2>Microsoft Authentication Required</h2>
              <p>You need to authenticate with your Microsoft account to play Minecraft.</p>
              <button class="auth-button" on:click={authenticateWithMicrosoft}>
                🔑 Login with Microsoft
              </button>
            </div>
          {:else if authStatus === 'authenticating'}
            <div class="auth-section">
              <h2>Authenticating...</h2>
              <p>Please complete the authentication process in your browser.</p>
              <p style="font-size: 0.9rem; color: #9ca3af; margin-top: 1rem;">
                If the browser closed but this message remains, the authentication may have succeeded.
              </p>
              <div style="display: flex; gap: 1rem; justify-content: center; margin-top: 1rem;">
                <button class="auth-button" on:click={checkAuthentication}>
                  🔄 Check Authentication
                </button>
                <button class="auth-button" on:click={() => { authStatus = 'needs-auth'; }}>
                  ❌ Reset
                </button>
              </div>
            </div>
          {:else if authStatus === 'authenticated' || (username && authData) || (username && username.length > 0)}
            <!-- Show game information and launch controls -->
            <div class="game-info">
              <h2>Ready to Play</h2>
              <div class="player-info">
                <span class="player-label">Logged in as:</span>
                <span class="player-name">{username}</span>
              </div>
              
              {#if serverInfo}
                <div class="server-info-display">
                  <div class="info-item">
                    <span class="info-label">Server:</span>
                    <span class="info-value">{serverInfo.serverInfo?.name || 'Minecraft Server'}</span>
                  </div>
                  <div class="info-item">
                    <span class="info-label">Version:</span>
                    <span class="info-value">
                      {#if serverInfo.loaderType && serverInfo.loaderType !== 'vanilla'}
                        {serverInfo.loaderType}/{serverInfo.minecraftVersion || 'Unknown'}
                        {#if serverInfo.loaderVersion}
                          <span class="loader-version">({serverInfo.loaderVersion})</span>
                        {/if}
                      {:else}
                        {serverInfo.minecraftVersion || 'Unknown'}
                      {/if}
                    </span>
                  </div>
                  <div class="info-item">
                    <span class="info-label">Required Mods:</span>
                    <span class="info-value">{requiredMods.length}</span>
                  </div>
                </div>
              {/if}
              
              <!-- Client synchronization status -->
              {#if clientSyncStatus === 'checking'}
                <div class="sync-status checking">
                  <h3>Checking Client Files...</h3>
                  <p>Verifying Minecraft client installation...</p>
                </div>
              {:else if clientSyncStatus === 'needed'}
                <div class="sync-status needed">
                  <h3>Client Files Need Download</h3>
                  {#if clientSyncInfo}
                    <p>{clientSyncInfo.reason}</p>
                    {#if clientSyncInfo.needsJava}
                      <p><strong>Java {clientSyncInfo.requiredJavaVersion} will be automatically downloaded and installed.</strong></p>
                    {/if}
                  {/if}
                  <p>Minecraft {serverInfo?.minecraftVersion || 'Unknown'} client files are required.</p>
                  <button class="download-button" on:click={downloadClient}>
                    📥 Download Minecraft Client {clientSyncInfo?.needsJava ? '& Java' : ''}
                  </button>
                </div>
              {:else if clientSyncStatus === 'downloading'}
                <div class="sync-status downloading">
                  <h3>Downloading Minecraft Client</h3>
                  <div class="launch-progress">
                    <p>{clientDownloadProgress.type}: {clientDownloadProgress.task}</p>
                    {#if clientDownloadProgress.total > 0}
                      <div class="progress-bar">
                        <div class="progress-fill" style="width: {(clientDownloadProgress.current / clientDownloadProgress.total) * 100}%"></div>
                      </div>
                      {#if clientDownloadProgress.type === 'Downloading' && clientDownloadProgress.totalMB}
                        <p class="progress-text">{clientDownloadProgress.current || 0} MB / {clientDownloadProgress.total} MB</p>
                      {/if}
                    {/if}
                  </div>
                </div>
              {:else if clientSyncStatus === 'ready'}
                <div class="sync-status ready">
                  <h3>✅ Client Files Ready</h3>
                  <p>Minecraft {serverInfo?.minecraftVersion || 'Unknown'} client is installed and ready.</p>
                  {#if clientSyncInfo?.javaVersion}
                    <p>Java {clientSyncInfo.javaVersion} is available and ready.</p>
                  {/if}
                </div>
              {/if}
              
              <!-- Mod synchronization status -->
              {#if downloadStatus === 'checking'}
                <div class="sync-status checking">
                  <h3>Checking Mods...</h3>
                  <p>Verifying installed mods...</p>
                </div>
              {:else if downloadStatus === 'needed'}
                <div class="sync-status needed">
                  <h3>Mods Need Update</h3>
                  {#if modSyncStatus}
                    <p>{modSyncStatus.needsDownload} out of {modSyncStatus.totalRequired} mods need to be downloaded.</p>
                    {#if modSyncStatus.missingMods && modSyncStatus.missingMods.length > 0}
                      <p class="missing-mods">Missing: {modSyncStatus.missingMods.join(', ')}</p>
                    {/if}
                    {#if modSyncStatus.outdatedMods && modSyncStatus.outdatedMods.length > 0}
                      <p class="outdated-mods">Outdated: {modSyncStatus.outdatedMods.join(', ')}</p>
                    {/if}
                  {/if}
                  <button class="download-button" on:click={onDownloadModsClick}>
                    📥 Download Required Mods
                  </button>
                </div>
              {:else if downloadStatus === 'downloading'}
                <div class="sync-status downloading">
                  <h3>Downloading Mods</h3>
                  <div class="progress-bar">
                    <div class="progress-fill" style="width: {downloadProgress}%"></div>
                  </div>
                  <p class="progress-text">Overall Progress: {downloadProgress}%</p>
                  {#if currentDownloadFile}
                    <div class="current-file-section">
                      <p class="current-file">Downloading: {currentDownloadFile}</p>
                      {#if fileProgress > 0}
                        <div class="file-progress-bar">
                          <div class="file-progress-fill" style="width: {fileProgress}%"></div>
                        </div>
                        <p class="file-progress-text">File Progress: {fileProgress}%</p>
                      {/if}
                      {#if downloadSpeed && downloadSpeed !== '0 MB/s'}
                        <p class="download-speed">{downloadSpeed}</p>
                      {/if}
                    </div>
                  {/if}
                  </div>
                {:else if downloadStatus === 'error'}
                  <div class="sync-status error">
                    <h3>Mod Check Failed</h3>
                    <p>Unable to verify mod status. Please refresh and try again.</p>
                  </div>
                {:else if downloadStatus === 'ready'}
                  <div class="sync-status ready">
                    <h3>✅ All Mods Ready</h3>
                    <p>All required mods are installed and up to date.</p>
                  </div>
                {/if}
              
              <!-- Memory Settings -->
              <div class="memory-settings">
                <h3>🧠 Memory Settings</h3>
                <div class="memory-setting">
                  <label for="max-memory">Maximum RAM (GB):</label>
                  <input 
                    type="number" 
                    id="max-memory"
                    bind:value={maxMemory} 
                    min="0.5" 
                    max="16" 
                    step="0.5"
                    disabled={isLaunching || launchStatus === 'running'}
                    title="Amount of RAM to allocate to Minecraft. Higher values may improve performance but require more system memory."
                  />
                  <span class="memory-info">
                    {maxMemory}GB
                    {#if maxMemory < 1}
                      (Low - may cause lag)
                    {:else if maxMemory >= 1 && maxMemory < 2}
                      (Recommended for most users)
                    {:else if maxMemory >= 2 && maxMemory < 4}
                      (Good for modded Minecraft)
                    {:else}
                      (High - ensure you have enough system RAM)
                    {/if}
                  </span>
                </div>
                {#if isLaunching || launchStatus === 'running'}
                  <p class="memory-disabled-note">Memory settings cannot be changed while Minecraft is launching or running.</p>
                {/if}
              </div>
              
              <!-- Launch controls -->
              <div class="launch-controls">
                {#if launchStatus === 'ready'}
                  {#if minecraftServerStatus === 'running' && clientSyncStatus === 'ready' && downloadStatus === 'ready'}
                    <button class="play-button" on:click={launchMinecraft}>
                      🎮 PLAY MINECRAFT
                    </button>
                  {:else}
                    <button class="play-button disabled" disabled>
                      {#if minecraftServerStatus !== 'running'}
                        ⏸️ WAITING FOR SERVER
                      {:else if clientSyncStatus !== 'ready'}
                        📥 DOWNLOAD CLIENT FIRST
                      {:else if downloadStatus !== 'ready'}
                        📥 DOWNLOAD MODS FIRST
                      {:else}
                        🎮 PLAY MINECRAFT
                      {/if}
                    </button>
                    {#if minecraftServerStatus !== 'running'}
                      <p class="server-status-message">
                        The Minecraft server is not running. Please wait for it to start.
                      </p>
                    {:else if clientSyncStatus !== 'ready'}
                      <p class="server-status-message">
                        Download the Minecraft client files before playing.
                      </p>
                    {:else if downloadStatus !== 'ready'}
                      <p class="server-status-message">
                        Download the required mods before playing.
                      </p>
                    {/if}
                  {/if}
                {:else if launchStatus === 'launching'}
                  <div class="launching-status">
                    <h3>🚀 Launching Minecraft...</h3>
                    <div class="launch-progress">
                      <p>{launchProgress.type}: {launchProgress.task}</p>
                      {#if launchProgress.total > 0}
                        <div class="progress-bar">
                          <div class="progress-fill" style="width: {(launchProgress.current / launchProgress.total) * 100}%"></div>
                        </div>
                      {/if}
                    </div>
                    <button class="stop-button" on:click={stopMinecraft}>
                      ⏹️ Cancel Launch
                    </button>
                  </div>
                {:else if launchStatus === 'running'}
                  <div class="running-status">
                    <h3>🎮 Minecraft is Running</h3>
                    <p>Minecraft is currently running. You can close this window.</p>
                    <button class="stop-button" on:click={stopMinecraft}>
                      ⏹️ Stop Minecraft
                    </button>
                  </div>
                {:else if launchStatus === 'error'}
                  <div class="error-status">
                    <h3>❌ Launch Failed</h3>
                    <p>There was an error launching Minecraft. Check the logs for details.</p>
                    <button class="retry-button" on:click={() => launchStatus = 'ready'}>
                      🔄 Try Again
                    </button>
                  </div>
                {/if}
              </div>
            </div>
          {:else}
            <!-- Catch-all for debugging -->
            <div class="auth-section">
              <h2>Status Check</h2>
              <p>Connection: {connectionStatus}</p>
              <p>Auth Status: {authStatus}</p>
              <p>Username: {username || 'None'}</p>
              <p>Auth Data: {authData ? 'Present' : 'Missing'}</p>
              <p>Condition Check: {authStatus === 'authenticated' || (username && authData)}</p>
              <div style="display: flex; gap: 1rem; justify-content: center; margin-top: 1rem;">
                <button class="auth-button" on:click={checkAuthentication}>
                  🔄 Check Authentication
                </button>
                <button class="auth-button" on:click={authenticateWithMicrosoft}>
                  🔑 Login with Microsoft
                </button>
              </div>
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
    {:else if activeTab === 'mods'}
      <div class="mods-container">
        <ClientModManager {instance} on:mod-sync-status={(e) => {
          // Update mod sync status when the mod manager reports changes
          modSyncStatus = e.detail;
          if (e.detail.synchronized) {
            downloadStatus = 'ready';
          } else {
            downloadStatus = 'needed';
          }
        }} />
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
              <span class="info-label">Management Server:</span>
              <span class="info-value">{instance.serverIp || 'Not configured'}:{instance.serverPort || '8080'}</span>
            </div>
            <div class="info-item">
              <span class="info-label">Client Path:</span>
              <span class="info-value">{instance.path || 'Not configured'}</span>
            </div>
            {#if authData}
              <div class="info-item">
                <span class="info-label">Authenticated as:</span>
                <span class="info-value">{authData.username}</span>
              </div>
            {/if}
          </div>
          
          <div class="auth-management">
            <h3>Authentication</h3>
            {#if authStatus === 'authenticated'}
              <p class="auth-status-text">✅ You are logged in as {username}</p>
              <button class="re-auth-button" on:click={authenticateWithMicrosoft}>
                🔄 Re-authenticate
              </button>
            {:else}
              <p class="auth-status-text">❌ Not authenticated</p>
              <button class="auth-button" on:click={authenticateWithMicrosoft}>
                🔑 Login with Microsoft
              </button>
            {/if}
          </div>
          
          <div class="client-management">
            <h3>Client Management</h3>
            {#if serverInfo?.minecraftVersion}
              <p class="client-status-text">
                Minecraft Version: {serverInfo.minecraftVersion}
              </p>
              <p class="client-status-text">
                Client Status: 
                {#if clientSyncStatus === 'ready'}
                  ✅ Ready
                {:else if clientSyncStatus === 'needed'}
                  ❌ Needs Download
                {:else if clientSyncStatus === 'downloading'}
                  ⬬ Downloading...
                {:else}
                  ❓ Unknown
                {/if}
              </p>
              
              <div class="client-actions">
                <button class="check-client-button" on:click={checkClientSynchronization}>
                  🔍 Check Client Files
                </button>
                <button class="redownload-client-button" on:click={redownloadClient}>
                  🔄 Re-download Client Files
                </button>
              </div>
              
              <p class="client-info-text">
                If Minecraft won't launch, try re-downloading the client files. This will clear any corrupted files and download fresh ones.
              </p>
            {:else}
              <p class="client-status-text">❌ No server connection to check client requirements</p>
            {/if}
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
  
  h1, h2, h3 {
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
  
  .status-section {
    display: flex;
    flex-direction: column;
    align-items: center;
    margin-top: 0.5rem;
    gap: 0.5rem;
  }
  
  .status-section-label {
    color: #9ca3af;
    font-size: 0.9rem;
  }
  
  .address-label {
    color: #9ca3af;
    font-size: 0.9rem;
    margin-right: 0.5rem;
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
    max-width: 600px;
    box-shadow: 0 4px 6px rgba(0, 0, 0, 0.1);
    margin-bottom: 2rem;
  }
  
  /* Auth section styles */
  .auth-section {
    padding: 2rem;
  }
  
  .auth-button, .re-auth-button {
    background-color: #0078d4;
    color: white;
    border: none;
    border-radius: 4px;
    padding: 0.75rem 1.5rem;
    font-size: 1rem;
    cursor: pointer;
    margin: 1rem 0;
    transition: background-color 0.2s;
  }
  
  .auth-button:hover, .re-auth-button:hover {
    background-color: #106ebe;
  }
  
  /* Game info styles */
  .game-info {
    padding: 1rem;
  }
  
  .player-info {
    margin: 1rem 0;
    padding: 0.5rem 1rem;
    background-color: #374151;
    border-radius: 0.5rem;
  }
  
  .player-label {
    color: #9ca3af;
    margin-right: 0.5rem;
  }
  
  .player-name {
    color: #10b981;
    font-weight: bold;
  }
  
  .server-info-display {
    margin: 1rem 0;
    padding: 1rem;
    background-color: #1f2937;
    border-radius: 0.5rem;
    display: flex;
    flex-direction: column;
    gap: 0.5rem;
  }
  
  .info-item {
    display: flex;
    justify-content: space-between;
    align-items: center;
  }
  
  .info-label {
    color: #9ca3af;
    font-size: 0.9rem;
  }
  
  .info-value {
    color: white;
    font-weight: 500;
  }
  
  /* Sync status styles */
  .sync-status {
    margin: 1.5rem 0;
    padding: 1rem;
    border-radius: 0.5rem;
  }
  
  .sync-status.checking {
    background-color: rgba(245, 158, 11, 0.1);
    border: 1px solid #f59e0b;
  }
  
  .sync-status.needed {
    background-color: rgba(239, 68, 68, 0.1);
    border: 1px solid #ef4444;
  }
  
  .sync-status.downloading {
    background-color: rgba(59, 130, 246, 0.1);
    border: 1px solid #3b82f6;
  }

  .sync-status.ready {
    background-color: rgba(16, 185, 129, 0.1);
    border: 1px solid #10b981;
  }

  .sync-status.error {
    background-color: rgba(239, 68, 68, 0.1);
    border: 1px solid #ef4444;
  }
  
  .missing-mods, .outdated-mods {
    font-size: 0.8rem;
    color: #fbbf24;
    font-family: monospace;
  }
  
  .download-button {
    background-color: #3b82f6;
    color: white;
    border: none;
    border-radius: 4px;
    padding: 0.75rem 1.5rem;
    font-size: 0.9rem;
    cursor: pointer;
    margin-top: 1rem;
  }
  
  .download-button:hover {
    background-color: #2563eb;
  }
  
  .check-sync-button {
    background-color: #6b7280;
    color: white;
    border: none;
    border-radius: 4px;
    padding: 0.5rem 1rem;
    font-size: 0.8rem;
    cursor: pointer;
    margin-top: 0.5rem;
  }
  
  .check-sync-button:hover {
    background-color: #4b5563;
  }
  
  /* Progress bar styles */
  .progress-bar {
    width: 100%;
    height: 0.75rem;
    background-color: #1f2937;
    border-radius: 0.5rem;
    overflow: hidden;
    margin: 0.5rem 0;
  }
  
  .progress-fill {
    height: 100%;
    background-color: #3b82f6;
    transition: width 0.3s ease;
  }
  
  .progress-text {
    font-size: 0.8rem;
    color: #e2e8f0;
    margin: 0.25rem 0;
  }
  
  .current-file {
    font-size: 0.75rem;
    color: #9ca3af;
    font-family: monospace;
    margin: 0.25rem 0;
  }
  
  .current-file-section {
    margin-top: 1rem;
    padding: 0.5rem;
    background-color: rgba(255, 255, 255, 0.05);
    border-radius: 0.25rem;
  }
  
  .file-progress-bar {
    width: 100%;
    height: 0.5rem;
    background-color: #1f2937;
    border-radius: 0.25rem;
    overflow: hidden;
    margin: 0.25rem 0;
  }
  
  .file-progress-fill {
    height: 100%;
    background-color: #10b981;
    transition: width 0.3s ease;
  }
  
  .file-progress-text {
    font-size: 0.7rem;
    color: #e2e8f0;
    margin: 0.25rem 0;
  }
  
  .download-speed {
    font-size: 0.7rem;
    color: #3b82f6;
    margin: 0.25rem 0;
  }
  
  /* Launch controls */
  .launch-controls {
    margin-top: 2rem;
  }
  
  .play-button {
    background-color: #10b981;
    color: white;
    border: none;
    border-radius: 8px;
    padding: 1rem 2rem;
    font-size: 1.25rem;
    font-weight: bold;
    cursor: pointer;
    transition: all 0.2s;
    width: 100%;
    max-width: 300px;
    margin: 1rem auto;
    display: block;
    text-transform: uppercase;
    letter-spacing: 1px;
  }
  
  .play-button:hover:not(.disabled) {
    background-color: #059669;
    transform: translateY(-2px);
    box-shadow: 0 4px 12px rgba(16, 185, 129, 0.3);
  }
  
  .play-button.disabled {
    background-color: #4b5563;
    cursor: not-allowed;
    color: #9ca3af;
  }
  
  .stop-button, .retry-button {
    background-color: #ef4444;
    color: white;
    border: none;
    border-radius: 4px;
    padding: 0.75rem 1.5rem;
    font-size: 0.9rem;
    cursor: pointer;
    margin-top: 1rem;
  }
  
  .stop-button:hover, .retry-button:hover {
    background-color: #dc2626;
  }
  
  .retry-button {
    background-color: #3b82f6;
  }
  
  .retry-button:hover {
    background-color: #2563eb;
  }
  
  .server-status-message {
    color: #ef4444;
    font-size: 0.875rem;
    margin-top: 0.5rem;
  }
  
  /* Launch status styles */
  .launching-status, .running-status, .error-status {
    padding: 1rem;
    border-radius: 0.5rem;
    margin: 1rem 0;
  }
  
  .launching-status {
    background-color: rgba(59, 130, 246, 0.1);
    border: 1px solid #3b82f6;
  }
  
  .running-status {
    background-color: rgba(16, 185, 129, 0.1);
    border: 1px solid #10b981;
  }
  
  .error-status {
    background-color: rgba(239, 68, 68, 0.1);
    border: 1px solid #ef4444;
  }
  
  .launch-progress p {
    font-size: 0.9rem;
    margin: 0.5rem 0;
  }
  
  .last-check {
    color: #9ca3af;
    font-size: 0.875rem;
    text-align: center;
    display: flex;
    align-items: center;
    justify-content: center;
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
    text-align: left;
  }
  
  .settings-info {
    display: flex;
    flex-direction: column;
    gap: 0.75rem;
    margin-bottom: 2rem;
  }
  
  .settings-info .info-item {
    display: flex;
    align-items: center;
    justify-content: flex-start;
  }
  
  .settings-info .info-label {
    width: 150px;
    color: #9ca3af;
    font-size: 0.9rem;
  }
  
  .settings-info .info-value {
    color: white;
    font-weight: 500;
  }
  
  .auth-management {
    margin-bottom: 2rem;
    padding: 1rem;
    background-color: rgba(59, 130, 246, 0.1);
    border-radius: 0.5rem;
    border: 1px solid #3b82f6;
  }
  
  .auth-management h3 {
    margin-top: 0;
    text-align: left;
    color: #3b82f6;
  }
  
  .auth-status-text {
    text-align: left;
    margin-bottom: 1rem;
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
    text-align: left;
  }
  
  .warning-text {
    color: rgba(255, 255, 255, 0.7);
    font-size: 0.9rem;
    margin-bottom: 1rem;
    text-align: left;
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
    text-align: left;
  }
  
  .delete-instance-button {
    background: rgba(255, 0, 0, 0.2);
    border: 1px solid rgba(255, 0, 0, 0.3);
    border-radius: 4px;
    padding: 0.5rem 1rem;
    cursor: pointer;
    font-size: 0.9rem;
    transition: all 0.2s ease;
    color: #ff5555;
  }
  
  .delete-instance-button:hover {
    background: rgba(255, 0, 0, 0.3);
  }
  
  /* Connection status display */
  .connection-status-display {
    padding: 2rem;
  }
  
  .auth-status-text {
    text-align: left;
    margin-bottom: 1rem;
  }
  
  .client-management {
    margin-bottom: 2rem;
    padding: 1rem;
    background-color: rgba(16, 185, 129, 0.1);
    border-radius: 0.5rem;
    border: 1px solid #10b981;
  }
  
  .client-management h3 {
    margin-top: 0;
    text-align: left;
    color: #10b981;
  }
  
  .client-status-text {
    text-align: left;
    margin-bottom: 0.5rem;
    color: #e2e8f0;
    font-size: 0.9rem;
  }
  
  .client-actions {
    display: flex;
    gap: 0.75rem;
    margin: 1rem 0;
    flex-wrap: wrap;
  }
  
  .check-client-button, .redownload-client-button {
    background-color: #10b981;
    color: white;
    border: none;
    border-radius: 4px;
    padding: 0.5rem 1rem;
    font-size: 0.85rem;
    cursor: pointer;
    transition: background-color 0.2s;
  }
  
  .check-client-button:hover {
    background-color: #059669;
  }
  
  .redownload-client-button {
    background-color: #f59e0b;
  }
  
  .redownload-client-button:hover {
    background-color: #d97706;
  }
  
  .client-info-text {
    text-align: left;
    font-size: 0.8rem;
    color: #9ca3af;
    margin-top: 0.5rem;
  }
  
  .debug-java-button {
    background-color: #6366f1;
    color: white;
    border: none;
    border-radius: 4px;
    padding: 0.5rem 1rem;
    font-size: 0.85rem;
    cursor: pointer;
    transition: background-color 0.2s;
  }
  
  .debug-java-button:hover {
    background-color: #4f46e5;
  }
  
  /* Memory Settings */
  .memory-settings {
    background: rgba(59, 130, 246, 0.1);
    border: 1px solid #3b82f6;
    border-radius: 8px;
    padding: 1.5rem;
    margin-bottom: 1.5rem;
  }
  
  .memory-settings h3 {
    margin-top: 0;
    margin-bottom: 1rem;
    color: #3b82f6;
    text-align: left;
  }
  
  .memory-setting {
    display: flex;
    flex-direction: column;
    gap: 0.5rem;
  }
  
  .memory-setting label {
    color: #e2e8f0;
    font-size: 0.9rem;
    font-weight: 500;
  }
  
  .memory-setting input[type="number"] {
    background: rgba(30, 41, 59, 0.8);
    border: 1px solid #374151;
    border-radius: 4px;
    padding: 0.75rem;
    color: white;
    font-size: 1rem;
    width: 200px;
    transition: border-color 0.2s;
  }
  
  .memory-setting input[type="number"]:focus {
    outline: none;
    border-color: #3b82f6;
  }
  
  .memory-setting input[type="number"]:disabled {
    opacity: 0.5;
    cursor: not-allowed;
  }
  
  .memory-info {
    color: #9ca3af;
    font-size: 0.85rem;
    margin-top: 0.25rem;
  }
  
  .memory-disabled-note {
    color: #f59e0b;
    font-size: 0.8rem;
    margin-top: 0.5rem;
    text-align: left;
  }
  
  /* Launch Progress */
  .launch-progress-section {
    background: rgba(16, 185, 129, 0.1);
    border: 1px solid #10b981;
    border-radius: 8px;
    padding: 1.5rem;
    margin-bottom: 1.5rem;
    text-align: center;
  }
  
  .launch-progress-section h3 {
    margin-top: 0;
    margin-bottom: 1rem;
    color: #10b981;
  }
  
  .progress-indicator {
    display: flex;
    flex-direction: column;
    align-items: center;
    gap: 1rem;
  }
  
  .spinner {
    width: 40px;
    height: 40px;
    border: 4px solid rgba(16, 185, 129, 0.3);
    border-top: 4px solid #10b981;
    border-radius: 50%;
    animation: spin 1s linear infinite;
  }
  
  @keyframes spin {
    0% { transform: rotate(0deg); }
    100% { transform: rotate(360deg); }
  }
  
  .progress-text {
    color: #e2e8f0;
    font-size: 0.9rem;
    margin: 0;
  }

  /* Mods Container */
  .mods-container {
    width: 100%;
    max-width: 1200px;
    margin: 0 auto;
  }
</style> 