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
  import { openFolder } from '../../utils/folderUtils.js';
  
  // App settings handler
  export let onOpenAppSettings = () => {};
  
  // Minecraft version compatibility checker
  function checkMinecraftVersionCompatibility(modVersion, targetVersion) {
    if (!modVersion || !targetVersion) return false;
    
    // Exact match
    if (modVersion === targetVersion) return true;
    
    // Handle range format like ">=1.21.2 <=1.21.3" (from multi-version arrays)
    if (modVersion.includes('>=') && modVersion.includes('<=')) {
      const rangeParts = modVersion.split(' ');
      const minPart = rangeParts.find(p => p.startsWith('>='));
      const maxPart = rangeParts.find(p => p.startsWith('<='));
      
      if (minPart && maxPart) {
        const minVersion = minPart.substring(2).trim();
        const maxVersion = maxPart.substring(2).trim();
        return compareVersions(targetVersion, minVersion) >= 0 && 
               compareVersions(targetVersion, maxVersion) <= 0;
      }
    }
    
    // Handle version ranges like "1.21.x" or "1.21.*"
    if (modVersion.includes('.x') || modVersion.includes('.*')) {
      const baseVersion = modVersion.replace(/\.[x*].*$/, '');
      return targetVersion.startsWith(baseVersion + '.');
    }
    
    // Handle ">=" comparisons like ">=1.21.4-rc.3"
    if (modVersion.startsWith('>=')) {
      const minVersion = modVersion.substring(2).trim();
      return compareVersions(targetVersion, minVersion) >= 0;
    }
    
    // Handle ">" comparisons
    if (modVersion.startsWith('>')) {
      const minVersion = modVersion.substring(1).trim();
      return compareVersions(targetVersion, minVersion) > 0;
    }
    
    // Handle "<=" comparisons
    if (modVersion.startsWith('<=')) {
      const maxVersion = modVersion.substring(2).trim();
      return compareVersions(targetVersion, maxVersion) <= 0;
    }
    
    // Handle "<" comparisons
    if (modVersion.startsWith('<')) {
      const maxVersion = modVersion.substring(1).trim();
      return compareVersions(targetVersion, maxVersion) < 0;
    }
    
    // Handle "~" (approximately equal) like "~1.21.4"
    if (modVersion.startsWith('~')) {
      const baseVersion = modVersion.substring(1).trim();
      const [baseMajor, baseMinor] = baseVersion.split('.');
      const [targetMajor, targetMinor] = targetVersion.split('.');
      return baseMajor === targetMajor && baseMinor === targetMinor;
    }
    
    return false;
  }
  
  // Simple version comparison function
  function compareVersions(version1, version2) {
    // Remove any suffixes like "-rc.3", "-alpha", etc. for comparison
    const clean1 = version1.split('-')[0];
    const clean2 = version2.split('-')[0];
    
    const parts1 = clean1.split('.').map(Number);
    const parts2 = clean2.split('.').map(Number);
    
    const maxLength = Math.max(parts1.length, parts2.length);
    
    for (let i = 0; i < maxLength; i++) {
      const part1 = parts1[i] || 0;
      const part2 = parts2[i] || 0;
      
      if (part1 > part2) return 1;
      if (part1 < part2) return -1;
    }
    
    return 0;
  }  import {
    clientState,
    setConnectionStatus,
    setManagementServerStatus,
    setMinecraftServerStatus,
    setMinecraftVersion,
    setClientModVersionUpdates,
    clearVersionChangeDetected,
    setAppVersions,
    clearAppVersions
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
  const dispatch = createEventDispatcher();  // Reactive statement to check client mod compatibility when version changes
  $: if ($clientState.versionChangeDetected && $clientState.activeTab === 'play') {
    checkClientModVersionCompatibility(true); // Skip throttling for version changes
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
  let clientDownloadProgress = { type: '', task: '', total: 0, current: 0 };
  let clientSyncInfo = null;
  let isChecking = false;
  let lastCheck = null;
  
  // Server information
  let serverInfo = null;
  let requiredMods = [];  let modSyncStatus = null;
  // Sync local modSyncStatus with the shared store
  $: if (modSyncStatus !== null) {
    modSyncStatusStore.set(modSyncStatus);
  }
  
  // Cache for mod versions to prevent excessive API calls
  let modVersionsCache = new Map();
  let cacheTimestamp = 0;
  const CACHE_DURATION = 5 * 60 * 1000; // 5 minutes
  
  // Authentication information
  let authData = null;
  let username = '';
  
  // Launch progress
  let launchProgress = { type: '', task: '', total: 0 };
  
  // Connection check interval
  let connectionCheckInterval;
  let statusCheckInterval;
  
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
  
  // Memory/RAM settings - moved to PlayTab.svelte for proper persistence
  
  // Launch progress tracking
  let isLaunching = false;
    // Console spam reduction variables
  let previousServerInfo = null;
  let lastSyncKey = null;
    // Client mod version check throttling
  let lastVersionCheckTime = 0;
  let isVersionCheckRunning = false; // Prevent concurrent version checks
  const VERSION_CHECK_COOLDOWN = 5000; // 5 second cooldown between checks
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
      
      if (result.success && result.acknowledgedDeps && Array.isArray(result.acknowledgedDeps)) {
        // Set acknowledged deps from persistent storage
        acknowledgedDeps.update(() => {
          const newSet = new Set();
          result.acknowledgedDeps.forEach(dep => {
            if (dep && typeof dep === 'string') {
            newSet.add(dep.toLowerCase());
            }
          });
          return newSet;
        });
      } else {
      }
    } catch (error) {
      console.warn('[ClientInterface] Failed to load acknowledged dependencies:', error);
    }
  }

  // Connect to the Management Server (port 8080)
  async function connectToServer() {
    if (!instance || !instance.serverIp || !instance.serverPort) {
      setConnectionStatus('disconnected');
      clearAppVersions();
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
        
        // Register with the server and check app version compatibility
        await registerWithServer();
        await checkAppVersionCompatibility();
        
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
      clearAppVersions();
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
    }  }

  // Check app version compatibility between client and server
  async function checkAppVersionCompatibility() {
    try {
      // Get client app version
      const clientVersionResult = await window.electron.invoke('get-current-version');
      const clientVersion = clientVersionResult?.success ? clientVersionResult.version : '1.0.0';

      // Get server app version
      const appVersionUrl = `http://${instance.serverIp}:${instance.serverPort}/api/app/version`;
      const response = await fetch(appVersionUrl, {
        method: 'GET',
        signal: AbortSignal.timeout(5000)
      });

      if (response.ok) {
        const versionData = await response.json();
        if (versionData.success) {
          const serverVersion = versionData.appVersion || versionData.version;
          
          // Update version compatibility status
          setAppVersions(clientVersion, serverVersion);
        } else {
          // Server didn't provide version info, assume compatible
          setAppVersions(clientVersion, clientVersion);
        }
      } else {
        // Server doesn't support version endpoint, assume compatible
        setAppVersions(clientVersion, clientVersion);
      }
    } catch (err) {
      console.warn('Failed to check app version compatibility:', err);
      // On error, assume compatible to avoid blocking users
      clearAppVersions();
    }
  }
  
  // Check both management server and minecraft server status
  async function checkServerStatus(silentRefresh = false) {
    if ($clientState.connectionStatus !== 'connected') {
      setManagementServerStatus('unknown');
      setMinecraftServerStatus('unknown');
      return;
    }
    
    // Only show loading state for manual refreshes, not background checks
    if (!silentRefresh) {
      isChecking = true;
    }
    
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
        await getServerInfo(silentRefresh);
      } else {
        throw new Error('Management server not responding');
      }
      
      lastCheck = new Date();
    } catch (err) {
      setConnectionStatus('disconnected');
      setManagementServerStatus('unknown');
      setMinecraftServerStatus('unknown');
    }
    
    if (!silentRefresh) {
      isChecking = false;
    }
  }
    // Get server information including Minecraft version and required mods
  async function getServerInfo(silentRefresh = false) {
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
            await checkModSynchronization(silentRefresh);
              // Check client synchronization status
            await checkClientSynchronization(silentRefresh);
        }
      }
    } catch (err) {
      setMinecraftServerStatus('unknown');
    }
  }
  // Check client downloaded mods for compatibility with new Minecraft version
  async function checkClientModVersionCompatibility(skipThrottle = false) {
    if (!instance.path || !serverInfo?.minecraftVersion) {
      return;
    }

    // Prevent concurrent execution
    if (isVersionCheckRunning) {
      return;
    }
    
    isVersionCheckRunning = true;
    
    try {      // Throttle version checks to prevent excessive calls (unless skipThrottle is true)
      if (!skipThrottle) {        const now = Date.now();
        if (now - lastVersionCheckTime < VERSION_CHECK_COOLDOWN) {
          isVersionCheckRunning = false;
          return;
        }
        lastVersionCheckTime = now;
      } else {
        // Update timestamp even when skipping throttle to maintain proper timing
        lastVersionCheckTime = Date.now();
      }
      // Clear cache if it's too old
      const now = Date.now();
      if (now - cacheTimestamp > CACHE_DURATION) {
        modVersionsCache.clear();
        cacheTimestamp = now;
      }
      const result = await window.electron.invoke('get-client-installed-mod-info', instance.path);
        if (!result || result.length === 0) {
        // No client mods installed
        setClientModVersionUpdates(null);
        isVersionCheckRunning = false;
        return;
      }      // Filter out server-managed mods to avoid duplicates
      const managedFiles = get(serverManagedFiles);
      
      // Also check against server's required mods and allClientMods as additional filter
      const serverModFileNames = new Set();
      if (requiredMods && requiredMods.length > 0) {
        requiredMods.forEach(mod => {
          if (mod.fileName) {
            serverModFileNames.add(mod.fileName.toLowerCase());
          }
        });
      }
      if (serverInfo?.allClientMods && serverInfo.allClientMods.length > 0) {
        serverInfo.allClientMods.forEach(mod => {
          if (mod.fileName) {
            serverModFileNames.add(mod.fileName.toLowerCase());
          }
        });
      }      const clientOnlyMods = result.filter(mod => {
        const fileName = mod.fileName.toLowerCase();
        const isServerManaged = managedFiles.has(fileName) || serverModFileNames.has(fileName);
        return !isServerManaged;
      });
        if (clientOnlyMods.length === 0) {
        // No client-only mods to update
        setClientModVersionUpdates(null);
        isVersionCheckRunning = false;
        return;
      }
      
      const updates = [];
      const disables = [];
      const compatible = [];
      
      for (const mod of clientOnlyMods) {
        if (!mod.projectId) {
          // No project ID, can't check for updates - be conservative and suggest manual check
          compatible.push({
            name: mod.name || mod.fileName,
            fileName: mod.fileName,
            currentVersion: mod.versionNumber || 'Unknown',
            status: 'unknown',
            reason: 'No project ID - manual verification recommended'
          });
          continue;
        }
          try {          // Check for mod versions compatible with the new MC version (with caching)
          let versions;
          if (modVersionsCache.has(mod.projectId)) {
            versions = modVersionsCache.get(mod.projectId);
          } else {
            versions = await window.electron.invoke('get-mod-versions', {
              modId: mod.projectId,
              source: 'modrinth'
            });
            // Cache the result
            if (versions && versions.length > 0) {
              modVersionsCache.set(mod.projectId, versions);
            }
          }
          
          if (versions && versions.length > 0) {
            // Filter versions compatible with target MC version
            const compatibleVersions = versions.filter(v => 
              v.gameVersions && v.gameVersions.includes(serverInfo.minecraftVersion) &&
              v.loaders && v.loaders.includes('fabric')
            );
              if (compatibleVersions.length > 0) {
              // Sort by date to get the latest
              compatibleVersions.sort((a, b) => new Date(b.datePublished).getTime() - new Date(a.datePublished).getTime());
              const latestVersion = compatibleVersions[0];              // Check if current mod version is compatible with target MC version
              // First, try to use backend-extracted Minecraft version from the actual mod file
              let currentVersionSupportsTarget = false;
                // Check if the mod has minecraftVersion from backend metadata (most reliable)
              if (mod.minecraftVersion) {
                currentVersionSupportsTarget = checkMinecraftVersionCompatibility(mod.minecraftVersion, serverInfo.minecraftVersion);
              }
                // Fallback to Modrinth API data if backend metadata unavailable
              if (!currentVersionSupportsTarget && !mod.minecraftVersion) {
                const currentVersionInList = versions.find(v => v.versionNumber === mod.versionNumber);
                currentVersionSupportsTarget = currentVersionInList && 
                  currentVersionInList.gameVersions && 
                  currentVersionInList.gameVersions.includes(serverInfo.minecraftVersion);
              }

              // Check for updates in two scenarios:
              // 1. Current version is NOT compatible with target MC version (incompatible -> needs update)
              // 2. Current version IS compatible but there's a newer version specifically for target MC (upgrade available)
              if (!currentVersionSupportsTarget) {                
                // First try to find the same version number that supports the target MC version
                const sameVersionCompatible = compatibleVersions.find(v => v.versionNumber === mod.versionNumber);
                
                if (sameVersionCompatible) {
                  // Same version number exists that supports target MC - suggest "update" to that
                  updates.push({
                    name: mod.name || mod.fileName,
                    fileName: mod.fileName,
                    currentVersion: mod.versionNumber || 'Unknown',
                    newVersion: sameVersionCompatible.versionNumber,
                    projectId: mod.projectId,
                    versionId: sameVersionCompatible.id,
                    status: 'update_available',
                    reason: `Current version not compatible with Minecraft ${serverInfo.minecraftVersion}`
                  });                } else {
                  // No same version found, check if there's a different compatible version
                  if (latestVersion.versionNumber !== mod.versionNumber) {
                    // Always suggest the latest compatible version for incompatible mods
                    // (we don't need to check dates here since the current version is incompatible)
                    updates.push({
                      name: mod.name || mod.fileName,
                      fileName: mod.fileName,
                      currentVersion: mod.versionNumber || 'Unknown',
                      newVersion: latestVersion.versionNumber,
                      projectId: mod.projectId,
                      versionId: latestVersion.id,
                      status: 'update_available',
                      reason: `Current version not compatible with Minecraft ${serverInfo.minecraftVersion}`
                    });
                  } else {
                    console.warn(`${mod.name}: Current version ${mod.versionNumber} is incompatible with MC ${serverInfo.minecraftVersion}, but no different compatible version found`);
                    // Mark as incompatible rather than suggesting a non-update
                    disables.push({
                      name: mod.name || mod.fileName,
                      fileName: mod.fileName,
                      currentVersion: mod.versionNumber || 'Unknown',
                      status: 'incompatible',
                      reason: `No compatible version found for Minecraft ${serverInfo.minecraftVersion}`
                    });
                  }                }              } else {
                // Current version IS compatible - check if there's a newer or more specific version for target MC
                
                // Check if there's a version specifically built for the target MC version
                // even if it has the same version number
                const targetMCSpecificVersion = compatibleVersions.find(v => 
                  v.gameVersions && v.gameVersions.length === 1 && v.gameVersions[0] === serverInfo.minecraftVersion
                );
                
                if (targetMCSpecificVersion && targetMCSpecificVersion.versionNumber === mod.versionNumber) {
                  // There's a version with same number but specifically for target MC - check if it's different from current
                  const currentVersionInList = versions.find(v => v.versionNumber === mod.versionNumber);
                  // Also check if the mod's backend minecraft version supports the target (indicating it's already compatible)
                  const modSupportsTargetMC = mod.minecraftVersion && checkMinecraftVersionCompatibility(mod.minecraftVersion, serverInfo.minecraftVersion);
                  const modIsTargetMCSpecific = mod.minecraftVersion === serverInfo.minecraftVersion || 
                    (mod.minecraftVersion && mod.minecraftVersion.includes(serverInfo.minecraftVersion));
                  
                  // Enhanced check: If mod already supports target MC properly OR if the current version is already the target-specific version
                  const isCurrentVersionAlreadyTargetSpecific = currentVersionInList && 
                    (currentVersionInList.id === targetMCSpecificVersion.id || 
                     (currentVersionInList.gameVersions && currentVersionInList.gameVersions.includes(serverInfo.minecraftVersion)));
                    if (modSupportsTargetMC || modIsTargetMCSpecific || isCurrentVersionAlreadyTargetSpecific) {
                    compatible.push({
                      name: mod.name || mod.fileName,
                      fileName: mod.fileName,
                      currentVersion: mod.versionNumber || 'Unknown',
                      status: 'compatible'
                    });
                  } else if (currentVersionInList && targetMCSpecificVersion.id !== currentVersionInList.id) {
                    updates.push({
                      name: mod.name || mod.fileName,
                      fileName: mod.fileName,
                      currentVersion: mod.versionNumber || 'Unknown',
                      newVersion: targetMCSpecificVersion.versionNumber,
                      projectId: mod.projectId,
                      versionId: targetMCSpecificVersion.id,
                      status: 'update_available',                      reason: `Version optimized for Minecraft ${serverInfo.minecraftVersion}`
                    });
                  } else {
                    compatible.push({
                      name: mod.name || mod.fileName,
                      fileName: mod.fileName,
                      currentVersion: mod.versionNumber || 'Unknown',
                      status: 'compatible'
                    });
                  }
                } else if (latestVersion.versionNumber !== mod.versionNumber) {
                  // Different version number - check if there's a genuinely newer version available
                  const currentVersionInList = versions.find(v => v.versionNumber === mod.versionNumber);
                  
                  if (!currentVersionInList) {                    // Current version not found in API - try to find equivalent version with different format
                    // Handle cases like "0.14.6+mc1.21.3" vs "mc1.21.3-0.14.6-fabric"
                    
                    const equivalentVersion = versions.find(v => {
                      // Extract version numbers from both strings for comparison
                      const currentVersionNums = mod.versionNumber.match(/\d+\.\d+\.\d+/g) || [];
                      const currentMcVersion = mod.versionNumber.match(/(?:mc)?1\.21\.\d+/g) || [];
                      
                      const apiVersionNums = v.versionNumber.match(/\d+\.\d+\.\d+/g) || [];
                      const apiMcVersion = v.versionNumber.match(/(?:mc)?1\.21\.\d+/g) || [];
                      
                      // Check if they contain the same version numbers and MC version
                      const sameVersionNum = currentVersionNums.length > 0 && apiVersionNums.length > 0 && 
                        currentVersionNums.some(cv => apiVersionNums.some(av => cv === av));
                      const sameMcVersion = currentMcVersion.length > 0 && apiMcVersion.length > 0 &&
                        currentMcVersion.some(cv => apiMcVersion.some(av => cv.replace(/^mc/, '') === av.replace(/^mc/, '')));
                      
                      return sameVersionNum && sameMcVersion;
                    });
                      if (equivalentVersion) {
                      // Check if this equivalent version is the latest
                      if (equivalentVersion.id === latestVersion.id) {
                        compatible.push({
                          name: mod.name || mod.fileName,
                          fileName: mod.fileName,
                          currentVersion: mod.versionNumber || 'Unknown',
                          status: 'compatible'
                        });
                      } else {
                        // Compare dates
                        const latestVersionDate = new Date(latestVersion.datePublished);
                        const currentVersionDate = new Date(equivalentVersion.datePublished);
                        
                        if (latestVersionDate > currentVersionDate) {
                          updates.push({
                            name: mod.name || mod.fileName,
                            fileName: mod.fileName,
                            currentVersion: mod.versionNumber || 'Unknown',
                            newVersion: latestVersion.versionNumber,
                            projectId: mod.projectId,
                            versionId: latestVersion.id,
                            status: 'update_available',
                            reason: `Newer version available for Minecraft ${serverInfo.minecraftVersion}`
                          });
                        } else {
                          compatible.push({
                            name: mod.name || mod.fileName,
                            fileName: mod.fileName,
                            currentVersion: mod.versionNumber || 'Unknown',
                            status: 'compatible'
                          });
                        }
                      }                    } else {
                      // Current version not found in API - suggest latest compatible version
                      updates.push({
                        name: mod.name || mod.fileName,
                        fileName: mod.fileName,
                        currentVersion: mod.versionNumber || 'Unknown',
                        newVersion: latestVersion.versionNumber,
                        projectId: mod.projectId,
                        versionId: latestVersion.id,
                        status: 'update_available',
                        reason: `Newer version available for Minecraft ${serverInfo.minecraftVersion}`
                      });
                    }                  } else {
                    // Compare dates to determine if it's actually newer
                    const latestVersionDate = new Date(latestVersion.datePublished);
                    const currentVersionDate = new Date(currentVersionInList.datePublished);
                    
                    if (latestVersionDate > currentVersionDate) {
                      updates.push({
                        name: mod.name || mod.fileName,
                        fileName: mod.fileName,
                        currentVersion: mod.versionNumber || 'Unknown',
                        newVersion: latestVersion.versionNumber,
                        projectId: mod.projectId,
                        versionId: latestVersion.id,
                        status: 'update_available',
                        reason: `Newer version available for Minecraft ${serverInfo.minecraftVersion}`
                      });
                    } else {
                      // Current version is newer or same date - mark as compatible
                      compatible.push({
                        name: mod.name || mod.fileName,
                        fileName: mod.fileName,
                        currentVersion: mod.versionNumber || 'Unknown',
                        status: 'compatible'
                      });
                    }
                  }} else {
                  // Same version number and no target-specific version found
                  compatible.push({
                    name: mod.name || mod.fileName,
                    fileName: mod.fileName,
                    currentVersion: mod.versionNumber || 'Unknown',
                    status: 'compatible'
                  });
                }
              }
            } else {
              // No compatible versions found for target MC version
              disables.push({
                name: mod.name || mod.fileName,
                fileName: mod.fileName,
                currentVersion: mod.versionNumber || 'Unknown',
                status: 'incompatible',
                reason: `No compatible version found for Minecraft ${serverInfo.minecraftVersion}`
              });
            }
          } else {
            // No versions found at all from API
            disables.push({
              name: mod.name || mod.fileName,
              fileName: mod.fileName,
              currentVersion: mod.versionNumber || 'Unknown',
              status: 'incompatible',
              reason: 'No version information available from mod repository'
            });
          }
        } catch (error) {
          console.warn(`Failed to check compatibility for mod ${mod.name}:`, error);
          // FIXED: If we can't check versions, be conservative and suggest disabling
          disables.push({
            name: mod.name || mod.fileName,
            fileName: mod.fileName,
            currentVersion: mod.versionNumber || 'Unknown',
            status: 'incompatible',
            reason: 'Could not verify compatibility - disabled for safety. Manual check recommended.'
          });
        }      }
          const versionUpdates = {
        minecraftVersion: serverInfo.minecraftVersion,
        updates: updates,
        disables: disables,
        compatible: compatible,        hasUpdates: updates.length > 0,
        hasDisables: disables.length > 0,
        hasChanges: updates.length > 0 || disables.length > 0
      };
        
      setClientModVersionUpdates(versionUpdates);
      
    } catch (error) {
      console.error('Failed to check client mod version compatibility:', error);
      setClientModVersionUpdates(null);
    } finally {
      isVersionCheckRunning = false;
    }
  }
      // Check if client mods are synchronized with server
  async function checkModSynchronization(silentRefresh = false) {
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
    
    // Only show checking status for manual refreshes, not background checks
    if (!silentRefresh) {
      downloadStatus = 'checking';
    }
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
          removeServerManagedFiles(result.successfullyRemovedMods);
        }

        // Check if there are any mod changes that need attention
        const hasRequiredUpdates = ((result.missingMods?.length || 0) + (result.outdatedMods?.length || 0)) > 0;
        const hasOptionalUpdates = (result.outdatedOptionalMods?.length || 0) > 0;
        const hasRemovals = ((result.requiredRemovals?.length || 0) + (result.optionalRemovals?.length || 0)) > 0;

        // Integrate client mod version updates into main mod sync status
        let enhancedResult = { ...result };
        const clientVersionUpdates = $clientState.clientModVersionUpdates;
        
        if (clientVersionUpdates && clientVersionUpdates.hasChanges) {
          // Add client mod updates to a separate array instead of mixing with server mods
          if (clientVersionUpdates.updates && clientVersionUpdates.updates.length > 0) {
            const clientUpdates = clientVersionUpdates.updates.map(update => ({
              fileName: update.fileName,
              name: update.name,
              currentVersion: update.currentVersion,
              newVersion: update.newVersion,
              projectId: update.projectId,
              versionId: update.versionId,
              isClientMod: true, // Mark as client mod for special handling
              reason: update.reason
            }));
            
            enhancedResult.clientModUpdates = clientUpdates;
          }
          
          // Add client mod disables to a special array
          if (clientVersionUpdates.disables && clientVersionUpdates.disables.length > 0) {
            enhancedResult.clientModDisables = clientVersionUpdates.disables;
          }
        }
        
        // Recalculate work needed with client mods included
        const hasClientUpdates = clientVersionUpdates?.hasChanges || false;

        // Use filtered acknowledgments instead of raw acknowledgments
        const hasUnacknowledgedDeps = filteredAcknowledgments.length > 0;
        
        // Check if we have any actual work to do (including client mod updates)
        const hasAnyWork = hasRequiredUpdates || hasOptionalUpdates || hasRemovals || hasUnacknowledgedDeps || hasClientUpdates;
        
        // Update modSyncStatus to include client mod updates and corrected sync state
        modSyncStatus = {
          ...enhancedResult,
          acknowledgments: filteredAcknowledgments, // Use filtered acknowledgments
          synchronized: !hasAnyWork // Override synchronized based on actual work needed
        };

        // Only update status if it's necessary - avoid disrupting ready/checking states unnecessarily
        if (!hasAnyWork) {
          // Only change to ready if we're not already in a good state
          if (downloadStatus !== 'ready' && downloadStatus !== 'checking-updates') {
            downloadStatus = 'ready'; // No mods need attention
          }
        } else {
          // Only change to needed if we're not in checking state
          if (downloadStatus !== 'checking-updates') {
            downloadStatus = 'needed'; // Show as needed if ANY mod actions are required
          }
        }
      } else {
        downloadStatus = 'ready'; // Assume ready if check fails
      }
    } catch (err) {
      // Only set download status if this wasn't a silent refresh
      if (!silentRefresh) {
        downloadStatus = 'ready';
      }
    }
  }
    // Check if Minecraft client files are synchronized
  async function checkClientSynchronization(silentRefresh = false) {
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
    
    // Only show checking status for manual refreshes, not background checks
    if (!silentRefresh) {
      clientSyncStatus = 'checking';
    }
    
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
    // Show checking state for user feedback
    isChecking = true;
    
    try {
      // Use silent refresh to prevent content flickering, but keep button feedback
      await checkServerStatus(true);
      
      // Force a mod synchronization check to detect changes
      if ($clientState.connectionStatus === 'connected') {
        await checkModSynchronization(true);
          // Also trigger mod manager refresh if we have the component
        if (clientModManagerComponent?.refreshFromDashboard) {
          await clientModManagerComponent.refreshFromDashboard();
        }
      }
    } catch (err) {
      console.error('Error refreshing dashboard:', err);
    } finally {
      isChecking = false;
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
  async function authenticateWithMicrosoft(forceAuth = false) {
    
    // Check if already authenticated (but allow forced re-auth when forceAuth is true)
    if (authStatus === 'authenticated' && username && authData && !forceAuth) {
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
          // Remove timeout message since authentication might still be in progress
          // errorMessage.set('Authentication timed out. Please try again.');
          // setTimeout(() => errorMessage.set(''), 5000);
        }
      }
    }, 30000); // Increased to 30 second timeout
    
    try {
          const result = await window.electron.invoke('minecraft-auth', {
      clientPath: instance.path,
      forceAuth: forceAuth
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
  }  // Download required mods
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
    const totalDownloadsNeeded = ((modSyncStatus?.missingMods?.length || 0) + (modSyncStatus?.outdatedMods?.length || 0) + (modSyncStatus?.missingOptionalMods?.length || 0) + (modSyncStatus?.outdatedOptionalMods?.length || 0) + (modSyncStatus?.clientModUpdates?.length || 0));
    
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
          
          // Clear modSyncStatus removal arrays immediately to prevent UI showing empty state
          if (modSyncStatus) {
            modSyncStatus = {
              ...modSyncStatus,
              requiredRemovals: [],
              optionalRemovals: [],
              synchronized: true // Mark as synchronized since removals are complete
            };
          }
          
          // Refresh the mod sync status after a short delay
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
        isDownloadingMods = false;      }
      return;
    }

    
    // Check if we have any work to do (server mods OR client mod updates)
    const hasServerMods = requiredMods && requiredMods.length > 0;
    const hasClientUpdates = modSyncStatus?.clientModUpdates && modSyncStatus.clientModUpdates.length > 0;
    
    if (!hasServerMods && !hasClientUpdates) {
      console.log('❌ EARLY EXIT: No server mods or client updates, returning');      downloadStatus = 'ready';
      return;
    }
    
    // Set downloading state
    isDownloadingMods = true;
      // Validate that each server mod has necessary properties (only if we have server mods)
    if (hasServerMods) {
      const invalidMods = requiredMods.filter(mod => !mod.fileName || !mod.downloadUrl);
      if (invalidMods.length > 0) {
        errorMessage.set(`Invalid mod data: ${invalidMods.length} mods missing required properties`);
        setTimeout(() => errorMessage.set(''), 5000);
        isDownloadingMods = false;
        return;
      }
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
      };      // Add outdated required mods (with full data)
      if (modSyncStatus?.outdatedMods) {
        for (const outdatedMod of modSyncStatus.outdatedMods) {
          // Server mods only (client mods are handled separately now)
          const fullModData = findFullModData(outdatedMod.fileName);
          if (fullModData && fullModData.downloadUrl) {
            modsNeedingUpdates.push(fullModData);
          }
        }
      }
      
      // Add client mod updates separately
      if (modSyncStatus?.clientModUpdates) {
        for (const clientUpdate of modSyncStatus.clientModUpdates) {
          modsNeedingUpdates.push(clientUpdate);
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
      
      // Separate server mods from client mods
      const serverMods = modsNeedingUpdates.filter(mod => !mod.isClientMod);
      const clientMods = modsNeedingUpdates.filter(mod => mod.isClientMod);
      const serverOptionalMods = optionalModsNeedingUpdates.filter(mod => !mod.isClientMod);
      const clientOptionalMods = optionalModsNeedingUpdates.filter(mod => mod.isClientMod);
      
      let totalResults = { success: true, downloaded: 0, skipped: 0, removed: 0 };
      
      // Handle server mod downloads
      if (serverMods.length > 0 || serverOptionalMods.length > 0) {
        const serverResult = await window.electron.invoke('minecraft-download-mods', {
          clientPath: instance.path,
          requiredMods: serverMods,
          optionalMods: serverOptionalMods,
          allClientMods: (serverInfo?.allClientMods && serverInfo.allClientMods.length > 0) ? serverInfo.allClientMods : [...serverMods, ...serverOptionalMods],
          serverInfo: {
            serverIp: instance.serverIp,
            serverPort: instance.serverPort
          }
        });
        
        if (serverResult.success) {
          totalResults.downloaded += Number(serverResult.downloaded) || 0;
          totalResults.skipped += Number(serverResult.skipped) || 0;
          totalResults.removed += Number(serverResult.removed) || 0;
          
          if (serverResult.downloadedFiles && serverResult.downloadedFiles.length > 0) {
            serverManagedFiles.update((current) => {
              const newSet = new Set(current);
              serverResult.downloadedFiles.forEach((m) => newSet.add(m.toLowerCase()));
              return newSet;
            });
          }
          if (serverResult.removedMods && serverResult.removedMods.length > 0) {
            removeServerManagedFiles(serverResult.removedMods);
          }
        } else {
          totalResults.success = false;
          totalResults.error = serverResult.error;
        }
      }        // Handle client mod downloads (need to fetch download URLs first)
      if (clientMods.length > 0 || clientOptionalMods.length > 0) {
        const allClientUpdates = [...clientMods, ...clientOptionalMods];        
        // Fetch download URLs for client mod updates
        const clientUpdatesWithUrls = await Promise.all(allClientUpdates.map(async (update) => {
          try {
            if (!update.versionId) {
              console.error(`No version ID for client mod update: ${update.name}`);
              errorMessage.set(`No version ID found for ${update.name}. Cannot download update.`);
              return null;
            }
            
            // Fetch version details from Modrinth API to get download URL
            const versionResponse = await fetch(`https://api.modrinth.com/v2/version/${update.versionId}`);
            if (!versionResponse.ok) {
              const errorText = await versionResponse.text();
              console.error(`Failed to fetch version details for ${update.name}: ${versionResponse.status} ${versionResponse.statusText}`, errorText);
              errorMessage.set(`API Error: Failed to fetch version details for ${update.name} (${versionResponse.status})`);
              return null;
            }
            
            const versionData = await versionResponse.json();
            
            const primaryFile = versionData.files?.find(f => f.primary) || versionData.files?.[0];
            if (!primaryFile || !primaryFile.url) {
              console.error(`No download URL found for ${update.name}`);
              errorMessage.set(`No download file found for ${update.name}. Version may be invalid.`);
              return null;
            }          return {
            ...update,
            downloadUrl: primaryFile.url,
            // Note: Backend now maintains original filename instead of using API filename
            oldFileName: update.fileName // Keep track of original filename for backend consistency
          };
          } catch (error) {
            console.error(`Error fetching download URL for ${update.name}:`, error);
            errorMessage.set(`Network error fetching download info for ${update.name}: ${error.message}`);
            return null;
          }
        }));
          // Filter out any failed URL fetches
        const validClientUpdates = clientUpdatesWithUrls.filter(update => update && update.downloadUrl);
        
        if (validClientUpdates.length > 0) {
          const clientResult = await window.electron.invoke('download-client-mod-version-updates', {
            clientPath: instance.path,
            updates: validClientUpdates,
            minecraftVersion: serverInfo.minecraftVersion
          });          if (clientResult.success) {
            totalResults.downloaded += Number(clientResult.updated) || 0;
            // Clear client version updates after successful download
            setClientModVersionUpdates(null);
            // Also clear from localStorage to prevent race conditions
            localStorage.removeItem('clientModVersionUpdates');            // Force clear mod metadata cache for updated mods
            for (const update of validClientUpdates) {
              try {
                await window.electron.invoke('clear-client-mod-cache', {
                  clientPath: instance.path,
                  fileName: update.fileName
                });

                // Also force refresh the client mod info to bypass any caching
                await window.electron.invoke('get-client-installed-mod-info', instance.path);                setTimeout(async () => {
                  try {
                    await window.electron.invoke('get-client-installed-mod-info', instance.path);
                  } catch (error) {
                    console.warn(`Failed to check post-download metadata for ${update.fileName}:`, error);
                  }
                }, 500);
              } catch (error) {
                console.warn(`Failed to clear cache for ${update.fileName}:`, error);
              }
            }
          } else {
            totalResults.success = false;
            totalResults.error = (totalResults.error ? totalResults.error + '; ' : '') + clientResult.error;
          }        } else {
          console.warn('❌ No valid client mod updates with download URLs found');
          if (allClientUpdates.length > 0) {
            const failedUpdates = allClientUpdates.filter((_, index) => !clientUpdatesWithUrls[index] || !clientUpdatesWithUrls[index].downloadUrl);
            const failureReasons = failedUpdates.map(update => `${update.name}: Missing download URL`).join(', ');
            console.error('❌ Failed to process client updates:', failureReasons);
            errorMessage.set(`Failed to download ${failedUpdates.length} client mod update${failedUpdates.length !== 1 ? 's' : ''}: ${failureReasons}`);
            setTimeout(() => errorMessage.set(''), 15000);
          }
        }
      }      // Handle client mod disables (incompatible mods)
      if (modSyncStatus?.clientModDisables && modSyncStatus.clientModDisables.length > 0) {
        for (const modToDisable of modSyncStatus.clientModDisables) {
          try {
            const disableResult = await window.electron.invoke('toggle-client-mod', {
              clientPath: instance.path,
              modFileName: modToDisable.fileName,
              enabled: false // Disable the mod
            });
            
            if (disableResult.success) {
              totalResults.disabled = (totalResults.disabled || 0) + 1;
            } else {
              console.warn(`Failed to disable ${modToDisable.name}:`, disableResult.error);
            }
          } catch (error) {
            console.error(`Error disabling ${modToDisable.name}:`, error);
          }
        }
        
        // Clear client version updates after disabling incompatible mods
        setClientModVersionUpdates(null);
        localStorage.removeItem('clientModVersionUpdates');
      }
      
      const result = totalResults;
      
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
        const disabledCount = Number(result.disabled) || 0;
        let processed = downloadedCount + skippedCount + disabledCount;
        let message = `Successfully processed ${processed} mods`;
        if (result.downloaded > 0) {
          message += ` (${result.downloaded} downloaded`;
          if (result.skipped > 0) {
            message += `, ${result.skipped} already present`;
          }
          if (result.removed > 0) {
            message += `, ${result.removed} removed`;
          }
          if (result.disabled > 0) {
            message += `, ${result.disabled} disabled`;
          }
          message += ')';
        } else if (result.skipped > 0 || result.removed > 0 || result.disabled > 0) {
          message += ' (';
          const parts = [];
          if (result.skipped > 0) parts.push('all already present');
          if (result.removed > 0) parts.push(`${result.removed} removed`);
          if (result.disabled > 0) parts.push(`${result.disabled} disabled`);
          message += parts.join(', ');
          message += ')';
        }
          successMessage.set(message);
        setTimeout(() => successMessage.set(''), 5000);        // Re-check mod synchronization after download with a delay to allow file I/O to complete
        // Also give time for client mod version updates to be cleared
        setTimeout(async () => {
          // Show checking updates status while we verify everything
          downloadStatus = 'checking-updates';
          
          // Clear any cached client mod version updates to prevent stale data
          setClientModVersionUpdates(null);
          localStorage.removeItem('clientModVersionUpdates');
            // Force a complete refresh of mod detection
          await checkModSynchronization(true); // Use silent refresh to prevent status override

          // Wait a bit and force refresh client mod data before compatibility check
          setTimeout(async () => {
            // Force fresh client mod info load before checking compatibility
            try {
              // Force fresh reload of all client mod info (cache already cleared above)
              await window.electron.invoke('get-client-installed-mod-info', instance.path);
            } catch (error) {
              console.warn('Failed to refresh client mod info:', error);
            }
            await checkClientModVersionCompatibility(true);
            
            // After all checks complete, ensure we have the correct final status
            setTimeout(() => {
              if (downloadStatus === 'checking-updates') {
                // Only reset to ready if we're still in checking-updates state
                downloadStatus = 'ready';
              }
            }, 500);
          }, 1000); // Reduced delay since cache is already cleared above
        }, 3000);
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
          clientDownloadProgress = { type: 'Preparing', task: 'Starting download...', total: 0, current: 0 };
    
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
      // Trigger a sync check after download completes without disrupting ready status
      setTimeout(async () => {
        // Only perform sync check if we haven't already cleared the server info
        if (serverInfo && serverInfo.allClientMods && serverInfo.allClientMods.length > 0) {
          const wasReady = downloadStatus === 'ready';
          if (!wasReady) {
            downloadStatus = 'checking-updates';
          }
          
          await checkSyncStatus();
          
          // If we were ready before and still checking, restore ready status
          if (wasReady && downloadStatus === 'checking-updates') {
            downloadStatus = 'ready';
          }
        }
      }, 1000);
    }
  }
  
  // Clear and re-download client files (smart repair)
  async function redownloadClient() {
    if (!serverInfo?.minecraftVersion) {
      errorMessage.set('No Minecraft version specified by server');
      setTimeout(() => errorMessage.set(''), 5000);
      return;
    }
    
    try {
      
      // Clear existing client files first (smart repair - preserves libraries/assets)
      const clearResult = await window.electron.invoke('minecraft-clear-client', {
        clientPath: instance.path,
        minecraftVersion: serverInfo.minecraftVersion
      });
      
      if (clearResult.success) {
        successMessage.set(`Client repair started: ${clearResult.message}`);
        setTimeout(() => successMessage.set(''), 3000);
        
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

  // Full clear and re-download (everything including libraries and assets)
  async function redownloadClientFull() {
    if (!serverInfo?.minecraftVersion) {
      errorMessage.set('No Minecraft version specified by server');
      setTimeout(() => errorMessage.set(''), 5000);
      return;
    }
    
    try {
      
      // Clear ALL client files (full clear)
      const clearResult = await window.electron.invoke('minecraft-clear-client-full', {
        clientPath: instance.path,
        minecraftVersion: serverInfo.minecraftVersion
      });
      
      if (clearResult.success) {
        successMessage.set(`Full client clear completed: ${clearResult.message}`);
        setTimeout(() => successMessage.set(''), 5000);
        
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
  async function launchMinecraft(showDebugTerminal = false, maxMemoryGB = 2) {
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
    launchProgress = { type: 'Preparing', task: 'Refreshing authentication...', total: 0 };
    
    try {
      // CRITICAL FIX: Proactively refresh authentication before every launch
      // This ensures we never launch with stale/expired tokens
      console.log('🔐 Refreshing authentication before launch...');
      
      const refreshResult = await window.electron.invoke('minecraft-check-refresh-auth', {
        clientPath: instance.path
      });
      
      if (!refreshResult.success) {
        // Authentication refresh failed - require re-authentication
        isLaunching = false;
        launchStatus = 'ready';
        
        if (refreshResult.requiresAuth || refreshResult.error?.includes('re-authenticate')) {
          authStatus = 'needs-auth';
          username = '';
          authData = null;
          errorMessage.set('Your Microsoft authentication has expired. Please re-authenticate in the Settings tab.');
        } else {
          errorMessage.set(`Authentication refresh failed: ${refreshResult.error || 'Unknown error'}. Please try re-authenticating in Settings.`);
        }
        setTimeout(() => errorMessage.set(''), 8000);
        return;
      }
      
      if (refreshResult.refreshed) {
        console.log('✅ Authentication refreshed successfully before launch');
        successMessage.set('Authentication refreshed successfully');
        setTimeout(() => successMessage.set(''), 2000);
      } else {
        console.log('✅ Authentication is still valid');
      }
      
      // Update launch progress after auth refresh
      launchProgress = { type: 'Preparing', task: 'Initializing launcher...', total: 0 };
      
      const minecraftPort = serverInfo?.minecraftPort || '25565';
      const memoryInMB = Math.round(maxMemoryGB * 1024);
      
      const result = await window.electron.invoke('minecraft-launch', {
        clientPath: instance.path,
        minecraftVersion: serverInfo?.minecraftVersion || '1.20.1',
        serverIp: instance.serverIp,
        serverPort: minecraftPort, // This is the Minecraft game server port, not management port
        managementPort: instance.serverPort,
        clientName: instance.clientName,
        requiredMods,
        serverInfo,
        maxMemory: memoryInMB, // Convert GB to MB for launcher
        showDebugTerminal // Add debug terminal setting
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
        
        if (errorMsg.includes('Authentication expired') || errorMsg.includes('authserver.mojang.com') || errorMsg.includes('Invalid session') || errorMsg.includes('invalid session')) {
          // Even though we refreshed, if we still get auth errors, require re-authentication
          authStatus = 'needs-auth';
          username = '';
          authData = null;
          errorMsg = 'Authentication failed after refresh. Please re-authenticate in the Settings tab.';
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
      } else if (errorMsg.includes('Authentication') || errorMsg.includes('Invalid session') || errorMsg.includes('invalid session')) {
        authStatus = 'needs-auth';
        username = '';
        authData = null;
        errorMsg = 'Authentication error. Please re-authenticate in the Settings tab.';
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
      clientDownloadProgress = { type: 'Starting', task: `Downloading Minecraft ${data.version}...`, total: 0, current: 0 };
    });
    
    window.electron.on('launcher-client-download-progress', (data) => {
      clientDownloadProgress = data;
    });
    
    window.electron.on('launcher-client-download-complete', (data) => {
      isDownloadingClient = false;
      clientDownloadProgress = { type: 'Complete', task: 'Client download finished', total: 100, current: 100 };
      clientSyncStatus = 'ready';
      
      if (data.success) {
        successMessage.set(`Client download complete: ${data.message || 'Minecraft client files downloaded successfully'}`);
        setTimeout(() => successMessage.set(''), 5000);
        
        // Preserve server info and mod lists during client download completion
        // Don't trigger aggressive refresh that might clear mod information
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
    
    // Listen for server version changes to re-check app compatibility
    window.electron.on('server-version-changed', (data) => {
      if (data && data.port && data.port.toString() === instance.serverPort) {
        // This event is for our server, check app version compatibility
        setTimeout(() => {
          checkAppVersionCompatibility();
        }, 1000); // Small delay to ensure server is ready
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
      'client-mod-compatibility-report',
      'server-version-changed'
    ];
    
    events.forEach(event => {
      window.electron.removeAllListeners(event);
    });
  }
    // Set up periodic checks
  function setupChecks() {
    // Check connection immediately
    connectToServer();

    // Set up periodic connection check with backoff - ONLY if disconnected
    connectionCheckInterval = setInterval(() => {
      if ($clientState.connectionStatus === 'disconnected') {
        connectToServer();
      }
    }, 60000); // Every 60 seconds
      
    // Set up periodic server status check - ONLY if connected
    statusCheckInterval = setInterval(() => {
      if ($clientState.connectionStatus === 'connected') {
        checkServerStatus(true); // Silent refresh
      }
    }, 120000); // Every 2 minutes

    // Set up periodic mod synchronization check - ONLY if connected and not busy
    const modCheckInterval = setInterval(() => {
      if ($clientState.connectionStatus === 'connected' && 
          !isDownloadingClient && !isDownloadingMods && !isCheckingSync) {
        checkModSynchronization(true); // Silent refresh
      }
    }, 60000); // Every 60 seconds

    // Note: Removed periodic authentication refresh as it was too aggressive
    // Authentication will be checked/refreshed automatically when launching Minecraft
    // This matches the behavior of other Minecraft launchers like ATLauncher
    
    // Set up periodic launcher status check - ONLY when Minecraft is running
    const launcherStatusInterval = setInterval(async () => {
      if (launchStatus === 'running') {
        try {
          const status = await window.electron.invoke('minecraft-get-status');
          if (status && !status.isRunning && !status.isLaunching) {
            launchStatus = 'ready';
          }
        } catch (err) {
          // Silent error handling for periodic checks
        }
      }
    }, 15000); // Every 15 seconds when running
      // Store intervals for cleanup
    connectionCheckInterval = connectionCheckInterval;
    statusCheckInterval = statusCheckInterval;
    
    // Return cleanup function
    return () => {
      if (connectionCheckInterval) clearInterval(connectionCheckInterval);
      if (statusCheckInterval) clearInterval(statusCheckInterval);
      if (launcherStatusInterval) clearInterval(launcherStatusInterval);
      if (modCheckInterval) clearInterval(modCheckInterval);    };
  }    // Reactive statement to refresh mod sync when switching to Play tab
  $: if ($clientState.activeTab === 'play' && $clientState.connectionStatus === 'connected' && 
         serverInfo?.allClientMods && serverInfo.allClientMods.length > 0 &&
         serverInfo.allClientMods.some(mod => mod.hasOwnProperty('required'))) {
    // Small delay to allow any pending operations to complete
    setTimeout(() => {
      checkModSynchronization();
    }, 100);  }
  
  onMount(() => {
    // Initialize client functionality
    setupLauncherEvents();
    
    // Load any persisted mod state so the Play tab reflects accurate
    // synchronization status before visiting the Mods tab
    (async () => {
      try {
        // Load acknowledged dependencies FIRST
        await loadAcknowledgedDependencies();
        
        const state = await window.electron.invoke('load-expected-mod-state', {
          clientPath: instance.path
        });
        if (state.success && Array.isArray(state.expectedMods)) {
          serverManagedFiles.set(
            new Set(state.expectedMods.map((m) => m.toLowerCase()))
          );
        }
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
        console.error('Mod state persistence error:', errorData);      }
    });    // Initial client mod version check (run after server state loads)
    const checkForClientUpdates = () => {
      if (instance?.path && serverInfo?.minecraftVersion) {        checkClientModVersionCompatibility(true); // Skip throttling for initial check
      } else {
        // Retry in 200ms if server info isn't ready yet
        setTimeout(checkForClientUpdates, 200);
      }
    };
    
    // Start checking immediately
    checkForClientUpdates();
    
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

  // Handle authentication state changes from child components
  function handleAuthStateChanged(event) {
    const { authStatus: newAuthStatus, username: newUsername, authData: newAuthData } = event.detail;
    authStatus = newAuthStatus;
    username = newUsername;
    authData = newAuthData;
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
    
    // Remember the current status to be conservative about changes
    const previousStatus = downloadStatus;

    try {
      // Refresh client and mod synchronization separately
      await checkClientSynchronization();
      await checkModSynchronization();

      // Be very conservative about status changes - only change if there's a clear issue
      if (clientSyncStatus !== 'ready') {
        downloadStatus = 'needs-client';
      } else if (modSyncStatus?.synchronized) {
        // If mods are synchronized and we were ready/checking, stay that way
        if (previousStatus === 'ready' || previousStatus === 'checking-updates') {
          downloadStatus = previousStatus;
        } else {
          downloadStatus = 'ready';
        }
      } else {
        // Only change from ready/checking states if there's actually work to do
        const hasActualWork = (modSyncStatus?.missingMods?.length || 0) > 0 || 
                            (modSyncStatus?.outdatedMods?.length || 0) > 0 ||
                            (modSyncStatus?.requiredRemovals?.length || 0) > 0 ||
                            (modSyncStatus?.optionalRemovals?.length || 0) > 0 ||
                            (modSyncStatus?.clientModUpdates?.length || 0) > 0;
        
        if (hasActualWork) {
          downloadStatus = 'needs-mods';
        } else if (previousStatus === 'ready' || previousStatus === 'checking-updates') {
          // If no actual work and we were in a good state, preserve it
          downloadStatus = previousStatus;
        } else {
          downloadStatus = 'ready';
        }
      }

    } catch (error) {
      // Only change to error if we weren't in a good state
      if (previousStatus !== 'ready' && previousStatus !== 'checking-updates') {
        downloadStatus = 'error';
      }
    } finally {
      isCheckingSync = false;
    }
  }
  // Handle acknowledging all dependencies at once
  async function onAcknowledgeAllDependencies() {
    if (!modSyncStatus?.acknowledgments) return;

    try {
      const acknowledgedFiles = [];
      
      for (const ack of modSyncStatus.acknowledgments) {
        await window.electron.invoke('minecraft-acknowledge-dependency', {
          clientPath: instance.path,
          modFileName: ack.fileName
        });
        acknowledgedFiles.push(ack.fileName);
      }

      // Update acknowledged deps store
        acknowledgedDeps.update(set => {
          const updated = new Set(set);
        acknowledgedFiles.forEach(fileName => {
          updated.add(fileName.toLowerCase());
        });
          return updated;
        });

      // Remove from server-managed files
      removeServerManagedFiles(acknowledgedFiles);

      // Refresh after acknowledging all
      await checkModSynchronization();
      
      // Check if any newly acknowledged mods need version updates
      await checkClientModVersionCompatibility();

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
    }  }

  // ...existing code...
</script>

<style>
  .client-wrapper {
    width: 100%;
    background: #1a1a1a; /* Match app background */
  }

  /* Remove client-container - make this direct like server's tab-content */
  .client-interface {
    padding: 0.25rem 2rem 2rem 2rem; /* Same as server tab-content padding */
    position: relative;
    box-sizing: border-box;
    min-height: auto;
  }

  .client-content {
    /* Match server's content-panel exactly */
    width: var(--content-area-width) !important; /* 800px like content-panel */
    margin: 0 auto;
    box-sizing: border-box !important;
    padding: 0 !important; /* Let child components handle their own padding */
  }
</style>

<div class="client-wrapper">
  <ClientHeader {tabs} {onOpenAppSettings} />
  <div class="client-interface">
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
    {:else if $clientState.activeTab === 'mods'}
      <ModsTab
        {instance}
        bind:clientModManagerComponent
        {modSyncStatus}
        {downloadStatus}
        {getServerInfo}
        {refreshMods}
        {filteredAcknowledgments}
        clientModVersionUpdates={$clientState.clientModVersionUpdates}
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
        {clientDownloadProgress}
        {checkClientSynchronization}
        {redownloadClient}
        {redownloadClientFull}
        on:auth-state-changed={handleAuthStateChanged}
      />
    {/if}
  </div>
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

