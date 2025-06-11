<script>
  import { onMount, onDestroy } from 'svelte';
  import { get } from 'svelte/store';
  import ConfirmationDialog from '../common/ConfirmationDialog.svelte';
  import ClientModManager from './ClientModManager.svelte';
  import ClientHeader from './ClientHeader.svelte';
  import ClientModCompatibilityDialog from './ClientModCompatibilityDialog.svelte';  import { errorMessage, successMessage, serverManagedFiles } from '../../stores/modStore.js';
  import { createEventDispatcher } from 'svelte';
  import { openFolder } from '../../utils/folderUtils.js';
  import {
    clientState,
    setConnectionStatus,
    setManagementServerStatus,
    setMinecraftServerStatus
  } from '../../stores/clientStore.js';
  
  // Props
  export let instance = {
    serverIp: '',
    serverPort: '8080',  // Management server port, not Minecraft port
    path: '',
    id: '',
    name: '',
    type: 'client'
  }; // Client instance with serverIp, serverPort, path
  // Component references
  let clientModManagerComponent;
  
  // Create event dispatcher
  const dispatch = createEventDispatcher();
  
  // Client state management handled by store
  let downloadStatus = 'ready';               // ready, downloading, completed, failed
  let clientSyncStatus = 'ready';            // ready, checking, needed, downloading, failed (for client files)
  let authStatus = 'unknown';                // unknown, checking, authenticated, needs-auth
  let launchStatus = 'ready';               // ready, launching, running, error
  
  // Progress tracking
  let downloadProgress = 0;
  let downloadSpeed = '0 MB/s';
  let currentDownloadFile = '';  let fileProgress = 0;
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
  let authRefreshInterval;
  
  // Active tab tracking
  const tabs = ['play', 'mods', 'settings'];
  
  // Settings
  let deleteFiles = false;
  let showDeleteConfirmation = false;
    // Track download states more precisely
  let isDownloadingClient = false;
  let isDownloadingMods = false;
  let isCheckingSync = false;
  
  // Memory/RAM settings
  let maxMemory = 2; // Default 2GB (in GB instead of MB)
  
  // Launch progress tracking
  let isLaunching = false;
  
  // Console spam reduction variables
  let previousServerInfo = null;
  let lastSyncKey = null;
  // Client mod compatibility dialog state
  let showCompatibilityDialog = false;
  let compatibilityReport = null;  // Download progress tracking
  
  // Connect to the Management Server (port 8080)
  async function connectToServer() {
    if (!instance || !instance.serverIp || !instance.serverPort) {
      setConnectionStatus('disconnected');
      return;
    }

    setConnectionStatus('connecting');
    
    try {
      const managementUrl = `http://${instance.serverIp}:${instance.serverPort}/api/test`;
      
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

      const testData = await response.json();
      if (testData.success) {
        setConnectionStatus('connected');
        
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
      setConnectionStatus('disconnected');
      setManagementServerStatus('unknown');
      setMinecraftServerStatus('unknown');
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
      });        if (response.ok) {
        
        
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
    }
  }
  
  // Check both management server and minecraft server status
  async function checkServerStatus() {
    if ($clientState.connectionStatus !== 'connected') {
      setManagementServerStatus('unknown');
      setMinecraftServerStatus('unknown');
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
        setManagementServerStatus('running');
        
        // Get server info to check minecraft server status
        await getServerInfo();
      } else {
        throw new Error('Management server not responding');
      }
      
      lastCheck = new Date();
    } catch (err) {
      setConnectionStatus('disconnected');
      setManagementServerStatus('unknown');
      setMinecraftServerStatus('unknown');
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
          setMinecraftServerStatus(serverInfo.minecraftServerStatus || 'unknown');
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
      setMinecraftServerStatus('unknown');
    }
  }
    // Check if client mods are synchronized with server
  async function checkModSynchronization() {
    if (isDownloadingMods || isDownloadingClient) {
      return;
    }
    
    if (!instance.path || !requiredMods || requiredMods.length === 0) {
      downloadStatus = 'ready';
      return;
    }
    
    // If we're already in ready state (e.g., just after successful download), 
    // don't immediately override it unless there's a clear issue
    const wasReady = downloadStatus === 'ready';
    
    downloadStatus = 'checking';
      try {      const managedFiles = get(serverManagedFiles);
      const result = await window.electron.invoke('minecraft-check-mods', {
        clientPath: instance.path,
        requiredMods,
        allClientMods: serverInfo?.allClientMods || [],
        serverManagedFiles: Array.from(managedFiles)
      });
        if (result.success) {
        modSyncStatus = result;
          if (result.synchronized) {
          downloadStatus = 'ready';
        } else {
          // If we just had a successful download (wasReady), be more conservative
          // Only change to 'needed' if there are actually missing mods OR removals needed
          const hasDownloads = result.needsDownload > 0;
          const hasRemovals = (result.clientModChanges?.removals?.length || 0) > 0;
          
          if (wasReady && !hasDownloads && !hasRemovals) {
            downloadStatus = 'ready'; // Keep ready status if no actions needed
          } else {
            downloadStatus = 'needed'; // Show as needed if downloads OR removals required
          }
        }
        
        if (result.clientModChanges?.removals) {
        }
      } else {
        downloadStatus = 'ready'; // Assume ready if check fails
      }
    } catch (err) {
      downloadStatus = 'ready';
    }
  }
  
  // Check if Minecraft client files are synchronized
  async function checkClientSynchronization() {
    if (isDownloadingMods || isDownloadingClient) {
      return;
    }
    
    if (!instance.path || !serverInfo?.minecraftVersion) {
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
      
      
      if (result.success) {
        clientSyncInfo = result;
        
        if (result.synchronized) {
          clientSyncStatus = 'ready';
        } else {
          clientSyncStatus = 'needed';
        }
      } else {
        clientSyncStatus = 'ready'; // Assume ready if check fails
      }    } catch (err) {
      clientSyncStatus = 'ready';
    }
  }  // Handle refresh button in dashboard - refresh both server status AND mod information
  async function handleRefreshFromDashboard() {
    try {
      // First check server status
      await checkServerStatus();
      
      // Force a mod synchronization check to detect changes
      if ($clientState.connectionStatus === 'connected') {
        await checkModSynchronization();
          // Also trigger mod manager refresh if we have the component
        if (clientModManagerComponent?.refreshFromDashboard) {
          await clientModManagerComponent.refreshFromDashboard();
        }
      }
    } catch (err) {
      console.error('Error refreshing dashboard:', err);
    }
  }
  
  // Handle refresh request from mods manager (triggered by dashboard refresh)
  function refreshMods() {
    // This will be handled by the ClientModManager component
    // when it receives the 'refresh-mods' event
  }
  
  // Check authentication status
  async function checkAuthentication() {
    
    if (!instance.path) {
      authStatus = 'needs-auth';
      return;
    }
    
    // Only set to checking if we're not already authenticated
    // and not currently authenticating
    if (authStatus !== 'authenticated' && authStatus !== 'authenticating') {
      authStatus = 'checking';
    }
    
    try {
      
      // Add timeout to prevent getting stuck in checking state
      const authTimeout = setTimeout(() => {
        if (authStatus === 'checking') {
          authStatus = 'needs-auth';
        }
      }, 5000);
      
      const result = await window.electron.invoke('minecraft-load-auth', {
        clientPath: instance.path
      });
      
      clearTimeout(authTimeout);
      
      if (result.success) {
        authStatus = 'authenticated';
        username = result.username;
        authData = { username: result.username, uuid: result.uuid };

        if (result.needsRefresh) {
          await refreshAuthToken();
        }
        
      } else {
        // Only set to needs-auth if we're not currently authenticating
        if (authStatus !== 'authenticating') {
          authStatus = 'needs-auth';
          username = '';
          authData = null;
        }
      }
    } catch (err) {
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
    
    // Check if already authenticated
    if (authStatus === 'authenticated' && username && authData) {
      successMessage.set(`Already authenticated as ${username}`);
      setTimeout(() => successMessage.set(''), 3000);
      return;
    }
    
    authStatus = 'authenticating';
    
    // Add a timeout to prevent getting stuck
    const authTimeout = setTimeout(async () => {
      
      // Only check if we're still in authenticating state
      if (authStatus === 'authenticating') {
        await checkAuthentication();
        
        // If we have username/authData after checking, the auth actually worked
        if (username && authData) {
          authStatus = 'authenticated';
          successMessage.set(`Authentication recovered for ${username}`);
          setTimeout(() => successMessage.set(''), 3000);
        } else {
          authStatus = 'needs-auth';
          errorMessage.set('Authentication timed out. Please try again.');
          setTimeout(() => errorMessage.set(''), 5000);
        }
      }
    }, 15000); // 15 second timeout
    
    try {
      const result = await window.electron.invoke('minecraft-auth', {
        clientPath: instance.path
      });
      
      // Clear the timeout since we got a response
      clearTimeout(authTimeout);
      
      if (result.success) {
        
        // Update authentication state
        authStatus = 'authenticated';
        username = result.username;
        authData = { username: result.username, uuid: result.uuid };
        
        // Save authentication data
        await window.electron.invoke('minecraft-save-auth', {
          clientPath: instance.path
        });
        
        // Trigger a single server status refresh now that we're authenticated
        // checkServerStatus will handle server info and sync checks
        await checkServerStatus();
        
        successMessage.set(`Successfully authenticated as ${result.username}`);
        setTimeout(() => successMessage.set(''), 3000);
        
      } else {
        authStatus = 'needs-auth';
        errorMessage.set('Authentication failed: ' + result.error);
        setTimeout(() => errorMessage.set(''), 5000);
      }
  } catch (err) {      // Clear the timeout since we got an error
      clearTimeout(authTimeout);
      
      
      // Check if auth actually succeeded despite the error
      await checkAuthentication();
      if (username && authData && authStatus === 'authenticated') {
        successMessage.set(`Authentication completed for ${username}`);
        setTimeout(() => successMessage.set(''), 3000);
      } else {
        authStatus = 'needs-auth';
        errorMessage.set('Authentication error: ' + err.message);
        setTimeout(() => errorMessage.set(''), 5000);
      }
    }
  }

  // Refresh authentication token if possible
  async function refreshAuthToken() {
    if (authStatus !== 'authenticated' || !instance.path) {
      return;
    }

    try {
      const result = await window.electron.invoke('minecraft-check-refresh-auth', {
        clientPath: instance.path
      });

      if (result.success && result.refreshed) {
        successMessage.set('Authentication refreshed');
        setTimeout(() => successMessage.set(''), 3000);
      } else if (!result.success && result.needsReauth) {
        errorMessage.set('Authentication expired. Use the "Re-authenticate" button in Settings.');
        setTimeout(() => errorMessage.set(''), 5000);
      }
    } catch (err) {
    }
  }
  
  // Download required mods with debug wrapper
  async function onDownloadModsClick() {
    
    // Show immediate loading state
    downloadStatus = 'downloading';
    downloadProgress = 0;
    
    try {
      await downloadMods();
    } catch (error) {
      errorMessage.set(`Download error: ${error.message}`);
      setTimeout(() => errorMessage.set(''), 5000);
      downloadStatus = 'needed'; // Reset status on error
    }
  }
  
  // Download required mods
  async function downloadMods() {
    
    // Validate required parameters
    if (!instance?.path) {
      errorMessage.set('No client path configured');
      setTimeout(() => errorMessage.set(''), 5000);
      return;
    }
    
    if (!requiredMods || requiredMods.length === 0) {
      downloadStatus = 'ready';
      return;
    }
    
    // Set downloading state
    isDownloadingMods = true;
      // Validate that each mod has necessary properties
    const invalidMods = requiredMods.filter(mod => !mod.fileName || !mod.downloadUrl);
    if (invalidMods.length > 0) {
      errorMessage.set(`Invalid mod data: ${invalidMods.length} mods missing required properties`);
      setTimeout(() => errorMessage.set(''), 5000);
      isDownloadingMods = false;
      return;
    }
    
    // Reset download state
    downloadProgress = 0;
    currentDownloadFile = '';    fileProgress = 0;
    
    // Set downloading status to show immediate feedback
    downloadStatus = 'downloading';
    
    try {
      const result = await window.electron.invoke('minecraft-download-mods', {
        clientPath: instance.path,
        requiredMods,
        allClientMods: serverInfo?.allClientMods || [],
        serverInfo: {
          serverIp: instance.serverIp,
          serverPort: instance.serverPort
        }
      });
      
      
      if (result.success) {
        downloadStatus = 'ready';
        downloadProgress = 100;
        
        let processed = result.downloaded + result.skipped;
        let message = `Successfully processed ${processed} mods`;
        if (result.downloaded > 0) {
          message += ` (${result.downloaded} downloaded`;
          if (result.skipped > 0) {
            message += `, ${result.skipped} already present`;
          }
          if (result.removed > 0) {
            message += `, ${result.removed} removed`;
          }
          message += ')';
        } else if (result.skipped > 0 || result.removed > 0) {
          message += ' (';
          const parts = [];
          if (result.skipped > 0) parts.push('all already present');
          if (result.removed > 0) parts.push(`${result.removed} removed`);
          message += parts.join(', ');
          message += ')';
        }
          successMessage.set(message);
        setTimeout(() => successMessage.set(''), 5000);
        
        // Re-check mod synchronization after download with a delay to allow file I/O to complete
        setTimeout(async () => {
          await checkModSynchronization();
        }, 1500);
      } else {
        downloadStatus = 'needed';
        let failureMsg = 'Failed to download mods';
        
        if (result.failures && result.failures.length > 0) {
          failureMsg = `Failed to download ${result.failures.length} mods`;
          
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
    
    if ($clientState.minecraftServerStatus !== 'running') {
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
    launchProgress = { type: 'Preparing', task: 'Initializing launcher...', total: 0 };
    
    try {
      const minecraftPort = serverInfo?.minecraftPort || '25565';
      
      const result = await window.electron.invoke('minecraft-launch', {
        clientPath: instance.path,
        minecraftVersion: serverInfo?.minecraftVersion || '1.20.1',
        serverIp: instance.serverIp,
        serverPort: minecraftPort, // This is the Minecraft game server port, not management port
        managementPort: instance.serverPort,
        clientName: instance.clientName,
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
      launchStatus = 'error';
      isLaunching = false;
      
      let errorMsg = err.message || 'Unknown launch error';
      
      // Handle network errors
      if (errorMsg.includes('ENOTFOUND') || errorMsg.includes('network')) {
        errorMsg = 'Network connection error. Please check your internet connection and try again.';
      } else if (errorMsg.includes('Authentication')) {
        errorMsg = 'Authentication error. Please re-authenticate with Microsoft in Settings.';
      }
      
      errorMessage.set('Launch error: ' + errorMsg);
      setTimeout(() => errorMessage.set(''), 8000);
    }
  }
  
  // Stop Minecraft if running
  async function stopMinecraft() {
    try {
      isLaunching = false;
      launchStatus = 'ready';
      
      const result = await window.electron.invoke('minecraft-stop');
      
      successMessage.set(result.message || 'Minecraft stopped successfully');
      setTimeout(() => successMessage.set(''), 3000);
    } catch (err) {
      launchStatus = 'ready'; // Reset status anyway
      errorMessage.set('Error stopping Minecraft: ' + err.message);
      setTimeout(() => errorMessage.set(''), 5000);
    }
  }


  
  // Set up launcher event listeners
  function setupLauncherEvents() {    // Download events
    window.electron.on('launcher-download-start', () => {
      downloadStatus = 'downloading';
      downloadProgress = 0;
    });
    
    window.electron.on('launcher-download-progress', (data) => {
      downloadProgress = Math.round((data.downloaded / data.total) * 100);
      currentDownloadFile = data.current || '';
      
      // Handle file-level progress if available
      if (data.fileProgress !== undefined) {
        fileProgress = data.fileProgress;
      }      if (data.downloadedBytes && data.totalSize) {
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
      
    });
    
    window.electron.on('launcher-download-complete', (data) => {
      downloadStatus = data.success ? 'ready' : 'needed';
      downloadProgress = 100;
      currentDownloadFile = '';
    });
    
    // Launch events
    window.electron.on('launcher-launch-start', () => {
      isLaunching = true;
      launchStatus = 'launching';
      launchProgress = { type: 'Starting', task: 'Preparing to launch...', total: 0 };
    });    window.electron.on('launcher-launch-progress', (data) => {
      launchProgress = data;
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
    
    window.electron.on('launcher-minecraft-closed', () => {
      launchStatus = 'ready';
    });
    
    // Auth events
    window.electron.on('launcher-auth-success', (data) => {
      
      // Only update if we have valid data and we're not already authenticated with this user
      if (data && data.username && (!username || username !== data.username)) {
        authStatus = 'authenticated';
        username = data.username;
        authData = data;
        
        // Trigger a single server status refresh after authentication
        setTimeout(async () => {
          await checkServerStatus();
        }, 100);
      }
    });
    
    window.electron.on('launcher-auth-error', (error) => {
      authStatus = 'needs-auth';
      errorMessage.set('Authentication failed: ' + error);
      setTimeout(() => errorMessage.set(''), 5000);
    });
    
    // Client download events
    window.electron.on('launcher-client-download-start', (data) => {
      clientSyncStatus = 'downloading';
      clientDownloadProgress = { type: 'Starting', task: `Downloading Minecraft ${data.version}...`, total: 0 };
    });
    
    window.electron.on('launcher-client-download-progress', (data) => {
      clientDownloadProgress = data;
    });
    
    window.electron.on('launcher-client-download-complete', (data) => {
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
      
    });
      window.electron.on('launcher-client-download-error', (data) => {
      clientSyncStatus = 'needed';
      errorMessage.set('Client download failed: ' + data.error);
      setTimeout(() => errorMessage.set(''), 5000);
    });
    
    // Client mod compatibility events
    window.electron.on('client-mod-compatibility-report', (report) => {
      compatibilityReport = report;
      
      // Show dialog if there are compatibility issues
      if (report.hasIncompatible || report.hasUpdatable) {
        showCompatibilityDialog = true;
      }
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
      'launcher-client-download-error',
      'client-mod-compatibility-report'
    ];
    
    events.forEach(event => {
      window.electron.removeAllListeners(event);
    });
  }
  
  // Set up periodic checks
  function setupChecks() {
    // Check connection immediately
    connectToServer();

    // Attempt an initial auth refresh after loading
    setTimeout(() => {
      refreshAuthToken();
    }, 5000);
    
    // Set up periodic connection check
    connectionCheckInterval = setInterval(() => {
      if ($clientState.connectionStatus === 'disconnected') {
        connectToServer();
      }
    }, 30000); // Every 30 seconds
    
    // Set up periodic server status check (reduced frequency)
    statusCheckInterval = setInterval(() => {
      if ($clientState.connectionStatus === 'connected') {
        checkServerStatus();
      }
    }, 60000); // Every 60 seconds (reduced frequency)

    // Set up periodic authentication refresh
    authRefreshInterval = setInterval(() => {
      refreshAuthToken();
    }, 30 * 60 * 1000); // Every 30 minutes
    
    // Set up periodic launcher status check to detect when Minecraft stops  
    const launcherStatusInterval = setInterval(async () => {
      if (launchStatus === 'running') {
        try {
          const status = await window.electron.invoke('minecraft-get-status');
          if (status && !status.isRunning && !status.isLaunching) {
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
      clearInterval(authRefreshInterval);
    });
  }
  
  // Clean up on component unmount
  onDestroy(() => {
    clearInterval(connectionCheckInterval);
    clearInterval(statusCheckInterval);
    clearInterval(authRefreshInterval);
    cleanupLauncherEvents();
  });
  
  // Debug Java installation function removed - no longer needed
  
  onMount(() => {
    // Initialize client functionality
    setupLauncherEvents();
    setupChecks();    window.electron.on('client-mod-compatibility-report', (data) => {
      if (data && data.report && data.newMinecraftVersion && data.oldMinecraftVersion) {
        compatibilityReport = data.report;
        showCompatibilityDialog = true; 
      } else {
      }
    });
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

  async function openClientFolder() {
    if (!instance?.path) return;

    if (window._folderOpenInProgress) {
      return;
    }

    window._folderOpenInProgress = true;

    try {
      await openFolder(instance.path);
    } finally {
      setTimeout(() => {
        window._folderOpenInProgress = false;
      }, 1000);
    }
  }
  
  // Prevent sync check when downloads are in progress
  async function checkSyncStatus() {
    if (isDownloadingClient || isDownloadingMods || isCheckingSync) {
      return;
    }

    if (!instance?.path || !serverInfo?.minecraftVersion) {
      return;
    }

    isCheckingSync = true;

    try {

      // Refresh client and mod synchronization separately
      await checkClientSynchronization();
      await checkModSynchronization();

      // Determine overall status
      if (clientSyncStatus !== 'ready') {
        downloadStatus = 'needs-client';      } else if (downloadStatus === 'ready') {
        downloadStatus = 'ready';
      } else if (downloadStatus === 'needed') {
        downloadStatus = 'needs-mods';
      }

    } catch (error) {
      downloadStatus = 'error';
    } finally {
      isCheckingSync = false;
    }
  }
  
  // Handle compatibility dialog events
  function handleCompatibilityDialogContinue() {
    showCompatibilityDialog = false;
    compatibilityReport = null;
  }
  
  async function handleCompatibilityDialogUpdateMods() {
    if (!compatibilityReport || !compatibilityReport.needsUpdate || compatibilityReport.needsUpdate.length === 0) {
      errorMessage.set('No mods available for update');
      setTimeout(() => errorMessage.set(''), 3000);
      return;
    }
    
    showCompatibilityDialog = false;
    
    try {
      
      // Update each mod that has an available update
      const updatePromises = compatibilityReport.needsUpdate.map(async (mod) => {
        if (mod.availableUpdate && mod.availableUpdate.projectId && mod.availableUpdate.version) {
          try {
            const result = await window.electron.invoke('update-client-mod', {
              clientPath: instance.path,
              fileName: mod.fileName,
              projectId: mod.availableUpdate.projectId,
              targetVersion: mod.availableUpdate.version
            });
            
            if (result.success) {
              return { success: true, mod: mod.fileName };
            } else {
              return { success: false, mod: mod.fileName, error: result.error };
            }
          } catch (error) {
            return { success: false, mod: mod.fileName, error: error.message };
          }
        }
        return { success: false, mod: mod.fileName, error: 'No update information available' };
      });
      
      const results = await Promise.all(updatePromises);
      const successful = results.filter(r => r.success);
      const failed = results.filter(r => !r.success);
      
      if (successful.length > 0) {
        successMessage.set(`Successfully updated ${successful.length} mod${successful.length > 1 ? 's' : ''}`);
        setTimeout(() => successMessage.set(''), 5000);
      }
      
      if (failed.length > 0) {
        errorMessage.set(`Failed to update ${failed.length} mod${failed.length > 1 ? 's' : ''}: ${failed.map(f => f.mod).join(', ')}`);
        setTimeout(() => errorMessage.set(''), 8000);
      }
      
    } catch (error) {
      errorMessage.set('Error updating mods: ' + error.message);
      setTimeout(() => errorMessage.set(''), 5000);
    }
    
    compatibilityReport = null;
  }

  async function handleCompatibilityDialogDisableIncompatible() {
    if (!compatibilityReport || !compatibilityReport.incompatible || compatibilityReport.incompatible.length === 0) {
      errorMessage.set('No incompatible mods to disable');
      setTimeout(() => errorMessage.set(''), 3000);
      return;
    }
    
    showCompatibilityDialog = false;
    
    try {
      
      const disablePromises = compatibilityReport.incompatible.map(async (mod) => {
        try {
          const result = await window.electron.invoke('disable-client-mod', {
            clientPath: instance.path,
            fileName: mod.fileName
          });
          
          if (result.success) {
            return { success: true, mod: mod.fileName };
          } else {
            return { success: false, mod: mod.fileName, error: result.error };
          }
        } catch (error) {
          return { success: false, mod: mod.fileName, error: error.message };
        }
      });
      
      const results = await Promise.all(disablePromises);
      const successful = results.filter(r => r.success);
      const failed = results.filter(r => !r.success);
      
      if (successful.length > 0) {
        successMessage.set(`Successfully disabled ${successful.length} incompatible mod${successful.length > 1 ? 's' : ''}`);
        setTimeout(() => successMessage.set(''), 5000);
      }
      
      if (failed.length > 0) {
        errorMessage.set(`Failed to disable ${failed.length} mod${failed.length > 1 ? 's' : ''}: ${failed.map(f => f.mod).join(', ')}`);
        setTimeout(() => errorMessage.set(''), 8000);
      }
      
    } catch (error) {
      errorMessage.set('Error disabling mods: ' + error.message);
      setTimeout(() => errorMessage.set(''), 5000);
    }
      compatibilityReport = null;
  }

</script>

<div class="client-container">
  <ClientHeader {instance} {tabs} minecraftServerStatus={$clientState.minecraftServerStatus} />
  
  <div class="client-content">
    {#if $clientState.activeTab === 'play'}
      <div class="client-main">
        <div class="client-status">
          {#if $clientState.connectionStatus !== 'connected'}
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
                </div>              {:else if downloadStatus === 'needed'}
                <div class="sync-status needed">
                  <h3>Mods Need Update</h3>                  {#if modSyncStatus}
                    <!-- Display appropriate message based on what needs to happen -->
                    {#if modSyncStatus.needsDownload > 0 && modSyncStatus.clientModChanges?.removals?.length > 0}
                      <p>{modSyncStatus.needsDownload} mod(s) need to be downloaded and {modSyncStatus.clientModChanges.removals.length} mod(s) need to be removed.</p>
                    {:else if modSyncStatus.needsDownload > 0}
                      <p>{modSyncStatus.needsDownload} out of {modSyncStatus.totalRequired || modSyncStatus.needsDownload} mods need to be downloaded.</p>
                    {:else if modSyncStatus.clientModChanges?.removals?.length > 0}
                      <p>{modSyncStatus.clientModChanges.removals.length} mod(s) need to be removed from your client.</p>
                    {:else}
                      <p>Mod synchronization required.</p>
                    {/if}
                    
                    <!-- New Downloads (Server-managed mods) -->
                    {#if modSyncStatus.missingMods && modSyncStatus.missingMods.length > 0}
                      <div class="mod-changes-section">
                        <h4>📥 New Downloads:</h4>
                        <ul class="mod-list">
                          {#each modSyncStatus.missingMods as modName (modName)}
                            <li class="mod-item new-download">{modName}</li>
                          {/each}
                        </ul>
                      </div>
                    {/if}

                    <!-- Client Mod Updates -->
                    {#if modSyncStatus.clientModChanges?.updates && modSyncStatus.clientModChanges.updates.length > 0}
                      <div class="mod-changes-section">
                        <h4>🔄 Mod Updates:</h4>
                        <ul class="mod-list">
                          {#each modSyncStatus.clientModChanges.updates as update (update.name)}
                            <li class="mod-item mod-update">
                              {update.name} v{update.currentVersion} → {update.serverVersion}
                            </li>
                          {/each}
                        </ul>
                      </div>
                    {/if}

                    <!-- Client Mod Removals - Show even when no downloads are needed -->
                    {#if modSyncStatus.clientModChanges?.removals && modSyncStatus.clientModChanges.removals.length > 0}
                      <div class="mod-changes-section">
                        <h4>❌ Mods to be Removed:</h4>
                        <ul class="mod-list">
                          {#each modSyncStatus.clientModChanges.removals as removal (removal.name)}
                            <li class="mod-item mod-removal">
                              {removal.name} → {removal.reason || (removal.action === 'remove' ? 'no longer required' : 'disabled')}
                            </li>
                          {/each}
                        </ul>
                      </div>
                    {/if}<!-- Legacy display for backwards compatibility -->
                    {#if modSyncStatus.outdatedMods && modSyncStatus.outdatedMods.length > 0}
                      <p class="outdated-mods">Outdated: {modSyncStatus.outdatedMods.join(', ')}</p>
                    {/if}
                  {/if}
                  
                  <!-- Show appropriate action button based on what's needed -->
                  {#if modSyncStatus && modSyncStatus.needsDownload > 0}
                    <button class="download-button" on:click={onDownloadModsClick}>
                      📥 Download Required Mods ({modSyncStatus.needsDownload})
                    </button>
                  {:else if modSyncStatus && modSyncStatus.clientModChanges?.removals?.length > 0}
                    <button class="download-button" on:click={onDownloadModsClick}>
                      🔄 Apply Mod Changes (Remove {modSyncStatus.clientModChanges.removals.length} mod{modSyncStatus.clientModChanges.removals.length > 1 ? 's' : ''})
                    </button>
                  {:else}
                    <button class="download-button" on:click={onDownloadModsClick}>
                      🔄 Synchronize Mods
                    </button>
                  {/if}
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
                  </div>                {:else if downloadStatus === 'ready'}
                  <div class="sync-status ready">
                    <h3>✅ All Required Mods Ready</h3>
                    {#if modSyncStatus && modSyncStatus.needsOptionalDownload && modSyncStatus.needsOptionalDownload > 0}
                      <p>All required mods are installed and up to date.</p>
                      <div class="optional-mods-notice">
                        <span class="optional-icon">ℹ️</span>
                        <span class="optional-text">
                          {modSyncStatus.needsOptionalDownload} optional mod{modSyncStatus.needsOptionalDownload > 1 ? 's are' : ' is'} available for download. 
                          Check the <strong>Mods</strong> tab to download them.
                        </span>
                      </div>
                    {:else}
                      <p>All mods are installed and up to date.</p>
                    {/if}
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
                  {#if $clientState.minecraftServerStatus === 'running' && clientSyncStatus === 'ready' && downloadStatus === 'ready'}
                    <button class="play-button" on:click={launchMinecraft}>
                      🎮 PLAY MINECRAFT
                    </button>
                  {:else}
                    <button class="play-button disabled" disabled>
                      {#if $clientState.minecraftServerStatus !== 'running'}
                        ⏸️ WAITING FOR SERVER
                      {:else if clientSyncStatus !== 'ready'}
                        📥 DOWNLOAD CLIENT FIRST
                      {:else if downloadStatus !== 'ready'}
                        📥 DOWNLOAD MODS FIRST
                      {:else}
                        🎮 PLAY MINECRAFT
                      {/if}
                    </button>
                    {#if $clientState.minecraftServerStatus !== 'running'}
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
              <p>Connection: {$clientState.connectionStatus}</p>
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
            <button class="refresh-button" on:click={handleRefreshFromDashboard}>
              Refresh
            </button>
          {/if}
        </div>
      </div>    {:else if $clientState.activeTab === 'mods'}
      <div class="mods-container">
        <ClientModManager 
          bind:this={clientModManagerComponent} 
          {instance}
          on:mod-sync-status={(e) => {            // Update mod sync status when the mod manager reports changes
            // Use the full sync result if available, otherwise use the event detail
            if (e.detail.fullSyncResult) {
              modSyncStatus = e.detail.fullSyncResult;
            } else {
              modSyncStatus = e.detail;
            }
            
            if (e.detail.synchronized) {
              downloadStatus = 'ready';
            } else {
              // Check if downloads or removals are needed
              const hasDownloads = e.detail.needsDownload > 0;
              const hasRemovals = (e.detail.fullSyncResult?.clientModChanges?.removals?.length || 0) > 0;
              
              if (hasDownloads || hasRemovals) {
                downloadStatus = 'needed';
              } else {
                downloadStatus = 'needed'; // Default to needed if not synchronized
              }
            }
          }}
          on:refresh-mods={refreshMods} 
        />
      </div>
    {:else if $clientState.activeTab === 'settings'}
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
              {#if instance.path}
                <button class="folder-button" on:click={openClientFolder} title="Open client folder">📁</button>
              {/if}
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

<!-- Client Mod Compatibility Dialog -->
<ClientModCompatibilityDialog
  bind:show={showCompatibilityDialog}
  {compatibilityReport}
  on:continue={handleCompatibilityDialogContinue}
  on:update-mods={handleCompatibilityDialogUpdateMods}
  on:disable-incompatible={handleCompatibilityDialogDisableIncompatible}
/>

<style>
  .client-container {
    width: 100%;
    min-height: 100vh;
    display: flex;
    flex-direction: column;
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

  /* Mod changes section styles */
  .mod-changes-section {
    margin: 1rem 0;
    padding: 0.75rem;
    background-color: rgba(255, 255, 255, 0.05);
    border-radius: 0.5rem;
    border-left: 3px solid #3b82f6;
  }

  .mod-changes-section h4 {
    margin: 0 0 0.5rem 0;
    font-size: 0.9rem;
    font-weight: 600;
    color: #e2e8f0;
  }

  .mod-list {
    list-style: none;
    padding: 0;
    margin: 0;
  }

  .mod-item {
    padding: 0.5rem 0.75rem;
    margin: 0.25rem 0;
    border-radius: 0.25rem;
    font-size: 0.8rem;
    font-family: monospace;
    display: flex;
    align-items: center;
  }

  .mod-item.new-download {
    background-color: rgba(59, 130, 246, 0.1);
    border: 1px solid rgba(59, 130, 246, 0.3);
    color: #60a5fa;
  }

  .mod-item.mod-update {
    background-color: rgba(245, 158, 11, 0.1);
    border: 1px solid rgba(245, 158, 11, 0.3);
    color: #fbbf24;
  }

  .mod-item.mod-removal {
    background-color: rgba(239, 68, 68, 0.1);
    border: 1px solid rgba(239, 68, 68, 0.3);
    color: #f87171;
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

  .folder-button {
    background: transparent;
    border: none;
    cursor: pointer;
    color: #3b82f6;
    font-size: 1rem;
    margin-left: 0.5rem;
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
  
  .client-info-text {    text-align: left;
    font-size: 0.8rem;
    color: #9ca3af;
    margin-top: 0.5rem;
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

  /* Optional Mods Notice */
  .optional-mods-notice {
    display: flex;
    align-items: center;
    gap: 0.75rem;
    margin-top: 1rem;
    padding: 0.75rem;
    background-color: rgba(59, 130, 246, 0.1);
    border: 1px solid rgba(59, 130, 246, 0.3);
    border-radius: 6px;
  }

  .optional-icon {
    font-size: 1rem;
    flex-shrink: 0;
    color: #3b82f6;
  }

  .optional-text {
    font-size: 0.9rem;
    color: #e2e8f0;
    line-height: 1.4;
  }

  .optional-text strong {
    color: #3b82f6;
    font-weight: 600;
  }
</style>