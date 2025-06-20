<script>
  import { onMount } from 'svelte';
  import { get } from 'svelte/store';
  import ConfirmationDialog from '../common/ConfirmationDialog.svelte';
  import ClientHeader from './ClientHeader.svelte';
  import ClientModCompatibilityDialog from './ClientModCompatibilityDialog.svelte';
  import PlayTab from './PlayTab.svelte';
  import ModsTab from './ModsTab.svelte';
  import SettingsTab from './SettingsTab.svelte';
import {
  errorMessage,
  successMessage,
  serverManagedFiles,
  removeServerManagedFiles
} from '../../stores/modStore.js';
import { acknowledgedDeps, modSyncStatus as modSyncStatusStore } from '../../stores/clientModManager';
  import { createEventDispatcher } from 'svelte';
  import { openFolder } from '../../utils/folderUtils.js';  import {
    clientState,
    setConnectionStatus,
    setManagementServerStatus,
    setMinecraftServerStatus,
    setMinecraftVersion,
    setClientModVersionUpdates,
    clearVersionChangeDetected
  } from '../../stores/clientStore.js';
  
  // Props
  export let instance = {
    serverIp: '',
    serverPort: '8080',  // Management server port, not Minecraft port
    path: '',
    id: '',
    name: '',
    type: 'client'
  }; // Client instance with serverIp, serverPort, path  // Component references
  let clientModManagerComponent;
  
  // Create event dispatcher
  const dispatch = createEventDispatcher();
  
  // Reactive statement to check client mod compatibility when version changes
  $: if ($clientState.versionChangeDetected && $clientState.activeTab === 'play') {
    checkClientModVersionCompatibility();
    clearVersionChangeDetected();
  }
  
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
  // Sync local modSyncStatus with the shared store
  $: if (modSyncStatus !== null) {
    modSyncStatusStore.set(modSyncStatus);
  }
  
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
  
  // Acknowledged dependencies tracking comes from the shared store
  
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
    // Computed property to filter out already acknowledged mods from acknowledgments  $: filteredAcknowledgments = (() => {  // Computed property to filter out already acknowledged mods from acknowledgments
  $: filteredAcknowledgments = (() => {
    if (!modSyncStatus?.acknowledgments) return [];

    const filtered = modSyncStatus.acknowledgments.filter(ack =>
      !$acknowledgedDeps.has(ack.fileName.toLowerCase())
    );
    
    return filtered;  })();

  // Function to load acknowledged dependencies from persistent storage
  async function loadAcknowledgedDependencies() {
    if (!instance?.path) return;
    
    try {
      const result = await window.electron.invoke('load-expected-mod-state', {
        clientPath: instance.path
      });
      
      if (result.success && result.acknowledgedDeps) {
        // Merge with existing acknowledged deps instead of overwriting
        acknowledgedDeps.update(currentSet => {
          const newSet = new Set(currentSet);
          result.acknowledgedDeps.forEach(dep => {
            newSet.add(dep.toLowerCase());
          });
          return newSet;
        });
      }
    } catch (error) {
      console.warn('[ClientInterface] Failed to load acknowledged dependencies:', error);
    }
  }

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
  }  // Get server information including Minecraft version and required mods
  async function getServerInfo() {
    try {
      const serverInfoUrl = `http://${instance.serverIp}:${instance.serverPort}/api/server/info`;
      const response = await fetch(serverInfoUrl, {
        method: 'GET',
        signal: AbortSignal.timeout(5000)
      });
      
      if (response.ok) {        serverInfo = await response.json();
        if (serverInfo.success) {
          setMinecraftServerStatus(serverInfo.minecraftServerStatus || 'unknown');
          requiredMods = serverInfo.requiredMods || [];
          
          // Track Minecraft version changes for client mod compatibility
          setMinecraftVersion(serverInfo.minecraftVersion);
          
          // **FIX**: Also fetch complete mod list from server to get optional mods info
          try {
            const modsUrl = `http://${instance.serverIp}:${instance.serverPort}/api/mods/list`;
            const modsResponse = await fetch(modsUrl, {
              method: 'GET',
              signal: AbortSignal.timeout(5000)
            });
              if (modsResponse.ok) {
              const modsData = await modsResponse.json();              if (modsData.success) {                // Only set serverInfo.allClientMods if it doesn't already exist with proper data
                // (ClientModManager sets it with required property, we don't want to overwrite that)
                if (!serverInfo.allClientMods || serverInfo.allClientMods.length === 0 || 
                    !serverInfo.allClientMods.some(mod => mod.hasOwnProperty('required'))) {
                  
                  const serverClientMods = modsData.mods.client || [];
                  
                  // Add any previously acknowledged mods that might not be in server's list anymore
                  const acknowledgedModNames = Array.from($acknowledgedDeps);
                  const mergedClientMods = [...serverClientMods];
                  
                  // For each acknowledged mod, ensure it's in the client mods list
                  for (const acknowledgedMod of acknowledgedModNames) {
                    const exists = mergedClientMods.some(mod => 
                      (mod.fileName || mod.name || '').toLowerCase() === acknowledgedMod.toLowerCase()
                    );
                    if (!exists) {
                      // Add the acknowledged mod as a client-downloaded mod
                      mergedClientMods.push({
                        fileName: acknowledgedMod,
                        name: acknowledgedMod.replace('.jar', ''),
                        required: false, // It's no longer required by server
                        clientDownloaded: true // Mark as client downloaded
                      });
                    }
                  }
                    serverInfo.allClientMods = mergedClientMods;
                }
              }
            }
          } catch (modsErr) {
            console.warn('Failed to fetch complete mod list:', modsErr);
          }
            
            // Track server info changes for UI updates only (no console spam)
            if (!previousServerInfo || 
                previousServerInfo.minecraftVersion !== serverInfo.minecraftVersion || 
                (previousServerInfo.requiredMods?.length || 0) !== requiredMods.length) {
              previousServerInfo = { minecraftVersion: serverInfo.minecraftVersion, requiredMods };
            }            // Check mod synchronization status
            await checkModSynchronization();
            
            // Check client synchronization status
            await checkClientSynchronization();
        }
      }
    } catch (err) {
      setMinecraftServerStatus('unknown');
    }
  }
    
  // Check client downloaded mods for compatibility with new Minecraft version
  async function checkClientModVersionCompatibility() {
    if (!instance.path || !serverInfo?.minecraftVersion) {
      return;
    }
    
    try {
      const result = await window.electron.invoke('get-client-installed-mod-info', instance.path);
      
      if (!result || result.length === 0) {
        // No client mods installed
        setClientModVersionUpdates(null);
        return;
      }
      
      const updates = [];
      const disables = [];
      const compatible = [];
      
      for (const mod of result) {
        if (!mod.projectId) {
          // No project ID, can't check for updates - assume compatible
          compatible.push({
            name: mod.name || mod.fileName,
            fileName: mod.fileName,
            currentVersion: mod.versionNumber || 'Unknown',
            status: 'compatible',
            reason: 'No project ID - manual verification recommended'
          });
          continue;
        }
        
        try {
          // Check for mod versions compatible with the new MC version
          const versions = await window.electron.invoke('get-mod-versions', {
            modId: mod.projectId,
            source: 'modrinth'
          });
          
          if (versions && versions.length > 0) {
            // Filter versions compatible with target MC version
            const compatibleVersions = versions.filter(v => 
              v.gameVersions && v.gameVersions.includes(serverInfo.minecraftVersion) &&
              v.loaders && v.loaders.includes('fabric')
            );
            
            if (compatibleVersions.length > 0) {
              // Sort by date to get the latest
              compatibleVersions.sort((a, b) => new Date(b.datePublished).getTime() - new Date(a.datePublished).getTime());
              const latestVersion = compatibleVersions[0];
              
              // Check if this is actually an update or same version
              if (latestVersion.versionNumber !== mod.versionNumber) {
                updates.push({
                  name: mod.name || mod.fileName,
                  fileName: mod.fileName,
                  currentVersion: mod.versionNumber || 'Unknown',
                  newVersion: latestVersion.versionNumber,
                  projectId: mod.projectId,
                  versionId: latestVersion.id,
                  status: 'update_available'
                });
              } else {
                // Same version, already compatible
                compatible.push({
                  name: mod.name || mod.fileName,
                  fileName: mod.fileName,
                  currentVersion: mod.versionNumber || 'Unknown',
                  status: 'compatible'
                });
              }
            } else {
              // No compatible versions found
              disables.push({
                name: mod.name || mod.fileName,
                fileName: mod.fileName,
                currentVersion: mod.versionNumber || 'Unknown',
                status: 'incompatible',
                reason: `No compatible version found for Minecraft ${serverInfo.minecraftVersion}`
              });
            }
          } else {
            // No versions found at all
            disables.push({
              name: mod.name || mod.fileName,
              fileName: mod.fileName,
              currentVersion: mod.versionNumber || 'Unknown',
              status: 'incompatible',
              reason: 'No version information available'
            });
          }
        } catch (error) {
          console.warn(`Failed to check compatibility for mod ${mod.name}:`, error);
          // If we can't check versions, assume compatible
          compatible.push({
            name: mod.name || mod.fileName,
            fileName: mod.fileName,
            currentVersion: mod.versionNumber || 'Unknown',
            status: 'compatible',
            reason: 'Could not verify compatibility - manual check recommended'
          });
        }
      }
      
      const versionUpdates = {
        minecraftVersion: serverInfo.minecraftVersion,
        updates: updates,
        disables: disables,
        compatible: compatible,
        hasUpdates: updates.length > 0,
        hasDisables: disables.length > 0,
        hasChanges: updates.length > 0 || disables.length > 0
      };
      
      setClientModVersionUpdates(versionUpdates);
      
    } catch (error) {
      console.error('Failed to check client mod version compatibility:', error);
      setClientModVersionUpdates(null);
    }
  }
    
  // Check if client mods are synchronized with server
  async function checkModSynchronization() {
    if (isDownloadingMods || isDownloadingClient) {
      return;
    }
      if (!instance.path) {
      downloadStatus = 'ready';
      return;
    }
    
    // Always check mod sync status, even if requiredMods is empty
    // (to detect removal/acknowledgment scenarios)
      // If we're already in ready state (e.g., just after successful download), 
    // don't immediately override it unless there's a clear issue
    
    downloadStatus = 'checking';
    try {
      const managedFiles = get(serverManagedFiles);      const filteredRequired = requiredMods.filter(
        m => !$acknowledgedDeps.has(m.fileName.toLowerCase())
      );
      // Don't filter acknowledged deps from allClientMods - they should remain visible
      // for potential re-acknowledgment when removed from server requirements
      const filteredAll = serverInfo?.allClientMods || [];
        const result = await window.electron.invoke('minecraft-check-mods', {
        clientPath: instance.path,
        requiredMods: filteredRequired,
        allClientMods: filteredAll,
        serverManagedFiles: Array.from(managedFiles)
      });
      if (result.success) {
        modSyncStatus = result;
        
        // Refresh acknowledged dependencies to ensure UI filtering is up to date
        await loadAcknowledgedDependencies();
        
        // Remove any mods that were deleted on the server
        if (result.successfullyRemovedMods && result.successfullyRemovedMods.length > 0) {
          removeServerManagedFiles(result.successfullyRemovedMods);        }        // Check if there are any mod changes that need attention
        const hasRequiredUpdates = ((result.missingMods?.length || 0) + (result.outdatedMods?.length || 0)) > 0;
        const hasOptionalUpdates = (result.outdatedOptionalMods?.length || 0) > 0;
        const hasRemovals = ((result.requiredRemovals?.length || 0) + (result.optionalRemovals?.length || 0)) > 0;        // Use filtered acknowledgments instead of raw acknowledgments
        const hasUnacknowledgedDeps = filteredAcknowledgments.length > 0;
        
        // Check if we have any actual work to do
        const hasAnyWork = hasRequiredUpdates || hasOptionalUpdates || hasRemovals || hasUnacknowledgedDeps;
        
        // Update modSyncStatus to reflect filtered acknowledgments and corrected sync state
        modSyncStatus = {
          ...result,
          acknowledgments: filteredAcknowledgments, // Use filtered acknowledgments
          synchronized: !hasAnyWork // Override synchronized based on actual work needed
        };
        
        // Only show "ready" status if no actual work is needed
        // (Don't rely solely on result.synchronized as it might not account for resolved acknowledgments)
        if (!hasAnyWork) {
          downloadStatus = 'ready'; // No mods need attention
        } else {
          downloadStatus = 'needed'; // Show as needed if ANY mod actions are required
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
  
  // Download required mods
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
      // Check if we have mods to remove
    const modsToRemove = [...(modSyncStatus?.requiredRemovals || []), ...(modSyncStatus?.optionalRemovals || [])];
      // If we only have removals and no downloads needed, handle removals directly
    const totalDownloadsNeeded = ((modSyncStatus?.missingMods?.length || 0) + (modSyncStatus?.outdatedMods?.length || 0) + (modSyncStatus?.missingOptionalMods?.length || 0) + (modSyncStatus?.outdatedOptionalMods?.length || 0));
    if (modsToRemove.length > 0 && (!requiredMods || requiredMods.length === 0 || totalDownloadsNeeded === 0)) {
      // Set removing state
      isDownloadingMods = true;
      downloadStatus = 'downloading';
        try {
        const result = await window.electron.invoke('minecraft-remove-server-managed-mods', {
          clientPath: instance.path,
          modsToRemove: modsToRemove.map(m => m.fileName)
        });

        if (result.success && result.removed && result.removed.length > 0) {
          downloadStatus = 'ready';
          successMessage.set(`Successfully removed ${result.removed.length} mod${result.removed.length > 1 ? 's' : ''}`);
          setTimeout(() => successMessage.set(''), 3000);
          
          // Remove from the server managed files store
          removeServerManagedFiles(result.removed);
          
          // Refresh the mod sync status
          setTimeout(async () => {
            await checkModSynchronization();
          }, 1500);
        } else {
          downloadStatus = 'needed';
          errorMessage.set(`Failed to remove mods: ${result.error || 'Unknown error'}`);
          setTimeout(() => errorMessage.set(''), 5000);
        }
      } catch (err) {
        downloadStatus = 'needed';
        errorMessage.set('Error removing mods: ' + err.message);
        setTimeout(() => errorMessage.set(''), 5000);
      } finally {
        isDownloadingMods = false;
      }
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
    downloadStatus = 'downloading';    try {
      // Prepare mods for bulk update - get full mod data with download URLs
      const modsNeedingUpdates = [];
      const optionalModsNeedingUpdates = [];
      
      // Helper function to find full mod data by filename
      const findFullModData = (fileName) => {
        // Search in requiredMods first
        let fullMod = requiredMods?.find(m => m.fileName === fileName);
        if (fullMod) return fullMod;
        
        // Search in serverInfo.allClientMods
        fullMod = serverInfo?.allClientMods?.find(m => m.fileName === fileName);
        return fullMod;
      };
      
      // Add outdated required mods (with full data)
      if (modSyncStatus?.outdatedMods) {
        for (const outdatedMod of modSyncStatus.outdatedMods) {
          const fullModData = findFullModData(outdatedMod.fileName);
          if (fullModData && fullModData.downloadUrl) {
            modsNeedingUpdates.push(fullModData);
          }
        }
      }
      
      // Add missing required mods (these should already have full data)
      if (modSyncStatus?.missingMods) {
        for (const missingMod of modSyncStatus.missingMods) {
          const fullModData = findFullModData(missingMod.fileName || missingMod);
          if (fullModData && fullModData.downloadUrl) {
            modsNeedingUpdates.push(fullModData);
          }
        }
      }
      
      // Add outdated optional mods (with full data)
      if (modSyncStatus?.outdatedOptionalMods) {
        for (const outdatedOptionalMod of modSyncStatus.outdatedOptionalMods) {
          const fullModData = findFullModData(outdatedOptionalMod.fileName);
          if (fullModData && fullModData.downloadUrl) {
            optionalModsNeedingUpdates.push(fullModData);
          }
        }
      }
      
      // Note: We don't include missingOptionalMods because those are new optional mods, not updates
      
      const result = await window.electron.invoke('minecraft-download-mods', {
        clientPath: instance.path,
        requiredMods: modsNeedingUpdates,
        optionalMods: optionalModsNeedingUpdates,
        allClientMods: (serverInfo?.allClientMods && serverInfo.allClientMods.length > 0) ? serverInfo.allClientMods : [...modsNeedingUpdates, ...optionalModsNeedingUpdates],
        serverInfo: {
          serverIp: instance.serverIp,
          serverPort: instance.serverPort
        }
      });
      
        if (result.success) {
        downloadStatus = 'ready';
        downloadProgress = 100;

        if (result.downloadedFiles && result.downloadedFiles.length > 0) {
          serverManagedFiles.update((current) => {
            const newSet = new Set(current);
            result.downloadedFiles.forEach((m) => newSet.add(m.toLowerCase()));
            return newSet;
          });
        }
        if (result.removedMods && result.removedMods.length > 0) {
          removeServerManagedFiles(result.removedMods);
        }
        
        const downloadedCount = Number(result.downloaded) || 0;
        const skippedCount = Number(result.skipped) || 0;
        let processed = downloadedCount + skippedCount;
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
        fileProgress = Math.round(data.fileProgress);
      }
      
      if (data.downloadedBytes && data.totalSize) {
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
        setTimeout(() => errorMessage.set(''), 5000);
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

    // Set up periodic mod synchronization check
    const modCheckInterval = setInterval(() => {
      if ($clientState.connectionStatus === 'connected') {
        checkModSynchronization();
      }
    }, 30000); // Every 30 seconds

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
      // Store intervals for cleanup
    connectionCheckInterval = connectionCheckInterval;
    statusCheckInterval = statusCheckInterval;
    authRefreshInterval = authRefreshInterval;
    
    // Return cleanup function
    return () => {
      if (connectionCheckInterval) clearInterval(connectionCheckInterval);
      if (statusCheckInterval) clearInterval(statusCheckInterval);
      if (authRefreshInterval) clearInterval(authRefreshInterval);
      if (launcherStatusInterval) clearInterval(launcherStatusInterval);
      if (modCheckInterval) clearInterval(modCheckInterval);    };
  }    // Reactive statement to refresh mod sync when switching to Play tab
  $: if ($clientState.activeTab === 'play' && $clientState.connectionStatus === 'connected' && 
         serverInfo?.allClientMods && serverInfo.allClientMods.length > 0 &&
         serverInfo.allClientMods.some(mod => mod.hasOwnProperty('required'))) {
    // Small delay to allow any pending operations to complete
    setTimeout(() => {
      checkModSynchronization();
    }, 100);
  }
    // Debug removed - no longer needed
  
  onMount(() => {
    // Initialize client functionality
    setupLauncherEvents();    // Load any persisted mod state so the Play tab reflects accurate
    // synchronization status before visiting the Mods tab
    (async () => {
      try {
        const state = await window.electron.invoke('load-expected-mod-state', {
          clientPath: instance.path
        });
        if (state.success && Array.isArray(state.expectedMods)) {
          serverManagedFiles.set(
            new Set(state.expectedMods.map((m) => m.toLowerCase()))
          );
        }
        
        // Load acknowledged dependencies for Play tab filtering
        await loadAcknowledgedDependencies();
      } catch (err) {
        console.warn('Failed to load persisted mod state:', err);
      }
    })();

    const cleanupChecks = setupChecks();
      window.electron.on('client-mod-compatibility-report', (data) => {
      if (data && data.report && data.newMinecraftVersion && data.oldMinecraftVersion) {
        compatibilityReport = data.report;
        showCompatibilityDialog = true; 
      } else {
      }
    });
    
    // Handle persistent mod state errors
    window.electron.on('mod-state-persistence-error', (errorData) => {
      if (errorData && errorData.message) {
        errorMessage.set(`Mod State Error: ${errorData.message}`);
        setTimeout(() => errorMessage.set(''), 8000);
        console.error('Mod state persistence error:', errorData);
      }
    });
    
    // Return cleanup function
    return () => {
      if (cleanupChecks) cleanupChecks();
      cleanupLauncherEvents();
    };
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
        downloadStatus = 'needs-client';      } else if (downloadStatus === 'ready' && modSyncStatus?.synchronized) {
        downloadStatus = 'ready';
      } else if (downloadStatus === 'needed') {
        downloadStatus = 'needs-mods';
      }

    } catch (error) {
      downloadStatus = 'error';    } finally {
      isCheckingSync = false;
    }
  }

  // Reactive statement to check client mod compatibility when version changes
  $: if ($clientState.versionChangeDetected && $clientState.activeTab === 'play') {
    checkClientModVersionCompatibility();
    clearVersionChangeDetected();
  }
  // Handle acknowledging all dependencies at once
  async function onAcknowledgeAllDependencies() {
    if (!modSyncStatus?.acknowledgments) return;

    try {
      for (const ack of modSyncStatus.acknowledgments) {
        await window.electron.invoke('minecraft-acknowledge-dependency', {
          clientPath: instance.path,
          fileName: ack.fileName,
          reason: ack.reason
        });
        // Update shared acknowledged set and remove from server-managed files
        acknowledgedDeps.update(set => {
          const updated = new Set(set);
          updated.add(ack.fileName.toLowerCase());
          return updated;
        });
        removeServerManagedFiles([ack.fileName]);
      }

      // Refresh after acknowledging all
      await checkModSynchronization();
      // Reload acknowledged deps to merge any backend updates
      await loadAcknowledgedDependencies();

      successMessage.set('All dependencies acknowledged successfully');
    } catch (error) {
      errorMessage.set('Failed to acknowledge dependencies: ' + error.message);
    }
  }

  // Handle compatibility dialog actions
  function handleCompatibilityDialogContinue() {
    showCompatibilityDialog = false;
    compatibilityReport = null;
  }

  async function handleCompatibilityDialogUpdateMods() {
    if (!compatibilityReport?.needsUpdate) return;
    
    try {
      for (const mod of compatibilityReport.needsUpdate) {
        await window.electron.invoke('install-client-mod', {
          id: mod.projectId,
          name: mod.name,
          selectedVersionId: mod.versionId,
          clientPath: instance.path,
          forceReinstall: true
        });
      }
      
      showCompatibilityDialog = false;
      await checkModSynchronization();
      successMessage.set('Client mods updated successfully');
    } catch (error) {
      console.error('Failed to update client mods:', error);
      errorMessage.set('Failed to update client mods: ' + error.message);
    }
  }

  async function handleCompatibilityDialogDisableIncompatible() {
    if (!compatibilityReport?.incompatible) return;
    
    try {
      for (const mod of compatibilityReport.incompatible) {
        await window.electron.invoke('disable-client-mod', {
          clientPath: instance.path,
          fileName: mod.fileName
        });
      }
      
      showCompatibilityDialog = false;
      await checkModSynchronization();
      successMessage.set('Incompatible client mods disabled successfully');
    } catch (error) {
      console.error('Failed to disable incompatible mods:', error);
      errorMessage.set('Failed to disable incompatible mods: ' + error.message);
    }
  }

  // ...existing code...
</script>

<div class="client-container">
  <ClientHeader {instance} {tabs} minecraftServerStatus={$clientState.minecraftServerStatus} />

  <div class="client-content">
    {#if $clientState.activeTab === 'play'}
      <PlayTab
        {authStatus}
        {authenticateWithMicrosoft}
        {checkAuthentication}
        {username}
        {authData}
        {serverInfo}
        {requiredMods}
        {clientSyncStatus}
        {clientSyncInfo}
        {downloadStatus}
        {modSyncStatus}
        {filteredAcknowledgments}
        {downloadClient}
        {onDownloadModsClick}
        {onAcknowledgeAllDependencies}
        {maxMemory}
        {isLaunching}
        {launchStatus}
        {launchMinecraft}
        {stopMinecraft}
        {launchProgress}
        {downloadProgress}
        {downloadSpeed}
        {currentDownloadFile}
        {fileProgress}
        {clientDownloadProgress}
        {handleRefreshFromDashboard}
        {lastCheck}
        {isChecking}
      />
    {:else if $clientState.activeTab === 'mods'}      <ModsTab
        {instance}
        bind:clientModManagerComponent
        {modSyncStatus}
        {downloadStatus}
        {getServerInfo}
        {refreshMods}
        {filteredAcknowledgments}
      />
    {:else if $clientState.activeTab === 'settings'}
      <SettingsTab
        {instance}
        {authStatus}
        {authData}
        {username}
        {authenticateWithMicrosoft}
        {openClientFolder}
        bind:deleteFiles
        {promptDelete}
        {serverInfo}
        {clientSyncStatus}
        {checkClientSynchronization}
        {redownloadClient}
      />
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

