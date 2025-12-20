<!-- @ts-ignore -->
<script>  /// <reference path="../../electron.d.ts" />
  import { onMount, onDestroy } from 'svelte';
  import { get } from 'svelte/store';
  import { serverState, updateServerMetrics } from '../../stores/serverState.js';
  import { clientState, setManagementServerStatus } from '../../stores/clientStore.js';
  import { playerState, updateOnlinePlayers, showContextMenu } from '../../stores/playerState.js';
  import PlayerContextMenu from '../players/PlayerContextMenu.svelte';
  import { validateServerPath } from '../../utils/folderUtils.js';
  import { errorMessage } from '../../stores/modStore.js';
  import { settingsStore, loadSettings } from '../../stores/settingsStore.js';
  import { latestVersions, refreshLatestVersions } from '../../stores/versionUpdates.js';
  import logger from '../../utils/logger.js';
  
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

  let statusCheckInterval;
  let isVisible = true;
  // Access global serverPath when local prop is empty
  $: {
    if (!serverPath && window.serverPath) {
      const candidate = /** @type {unknown} */ (window.serverPath.get());
      let handled = false;
      if (candidate && typeof candidate === 'object' && 'then' in candidate) {
        const promiseCandidate = /** @type {{ then?: unknown }} */ (candidate);
        if (typeof promiseCandidate.then === 'function') {
          handled = true;
          promiseCandidate.then((result) => {
            if (typeof result === 'string' && result) {
              serverPath = result;
            } else if (result && typeof result === 'object' && 'path' in result) {
              const resultPath = /** @type {{ path?: unknown }} */ (result).path;
              if (typeof resultPath === 'string' && resultPath) {
                serverPath = resultPath;
              }
            }
          }).catch(() => {});
        }
      }
      if (!handled) {
        if (typeof candidate === 'string' && candidate) {
          serverPath = candidate;
        } else if (candidate && typeof candidate === 'object' && 'path' in candidate) {
          const candidatePath = /** @type {{ path?: unknown }} */ (candidate).path;
          if (typeof candidatePath === 'string' && candidatePath) {
            serverPath = candidatePath;
          }
        }
      }
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
  // Server status tracking - use reactive statements only for display, not for overriding loaded values

  // Management server state
  let managementServerStatus = 'unknown'; // stopped, starting, running, stopping, unknown
  let managementPort = 8080;
  let managementSettingsLoaded = false;
  let connectedClients = 0;
  let inviteLink = '';
  let inviteHostInput = '';
  let inviteWarning = '';
  let inviteError = '';
  let inviteCopied = false;
  let inviteStatus = 'idle';
  let lastInviteKey = '';
  const MANAGEMENT_STATUS_VALUES = new Set(['running', 'stopped', 'starting', 'stopping', 'unknown', 'error']);
  let managementStatusSyncLock = false;

  function normalizeManagementStatus(value) {
    if (!value) {
      return 'unknown';
    }
    const normalized = String(value).toLowerCase();
    return MANAGEMENT_STATUS_VALUES.has(normalized) ? normalized : 'unknown';
  }

  function applyManagementStatus(status) {
    const normalized = normalizeManagementStatus(status);
    const currentStoreStatus = normalizeManagementStatus(get(clientState).managementServerStatus);
    if (managementServerStatus !== normalized) {
      managementServerStatus = normalized;
    }
    if (currentStoreStatus !== normalized) {
      managementStatusSyncLock = true;
      setManagementServerStatus(normalized);
      managementStatusSyncLock = false;
    }
  }

  $: if (!managementStatusSyncLock) {
    const storeStatus = normalizeManagementStatus($clientState.managementServerStatus);
    if (storeStatus !== managementServerStatus) {
      managementServerStatus = storeStatus;
    }
  }

  function coercePort(value) {
    if (value === null || value === undefined || value === '') return null;
    const parsed = Number.parseInt(String(value), 10);
    return Number.isFinite(parsed) ? parsed : null;
  }

  $: if (serverPath && managementPort && managementSettingsLoaded) {
    const inviteKey = `${serverPath}|${managementPort}`;
    if (inviteKey !== lastInviteKey) {
      lastInviteKey = inviteKey;
      loadInviteInfo();
    }
  } else if (!serverPath && (inviteLink || inviteHostInput)) {
    inviteLink = '';
    inviteHostInput = '';
    inviteWarning = '';
    inviteError = '';
  }
  
  // Auto-start settings
  let autoStartMinecraft = false;
  let autoStartManagement = false;
  let pendingAutoStart = false;
  let autoStartInProgress = false;

  $: if (pendingAutoStart && serverPath && managementSettingsLoaded && !window.appStartupCompleted) {
    void runAutoStartOnce();
  }
  
  // Help text dismissal
  let helpTextDismissed = false;
  
  // Function to dismiss help text
  function dismissHelpText() {
    helpTextDismissed = true;
    if (typeof window !== 'undefined' && window.localStorage) {
      localStorage.setItem('managementHelpDismissed', 'true');
    }
  }
  
  // Maintenance section state
  let maintenanceExpanded = false;
  let healthReport = [];
  let repairing = false;
  let repairProgress = 0;
  let repairSpeed = '0 MB/s';
  let repairLogs = [];
  let selectedMC;
  let selectedFabric;
  
  // Toggle maintenance section
  function toggleMaintenance() {
    maintenanceExpanded = !maintenanceExpanded;
    // Auto-check health when opened
    if (maintenanceExpanded && healthReport.length === 0) {
      checkHealth();
    }
  }
  
  // Maintenance functions
  async function checkHealth() {
    logger.info('Checking server health', {
      category: 'ui',
      data: {
        component: 'ServerControls',
        function: 'checkHealth',
        serverPath
      }
    });
    
    try {
      healthReport = (await window.electron.invoke('check-health', serverPath)) || [];
      
      logger.info('Server health check completed', {
        category: 'ui',
        data: {
          component: 'ServerControls',
          function: 'checkHealth',
          issuesFound: healthReport.length,
          healthReport
        }
      });
    } catch (err) {
      logger.error('Failed to check server health', {
        category: 'ui',
        data: {
          component: 'ServerControls',
          function: 'checkHealth',
          serverPath,
          errorMessage: err.message
        }
      });
      healthReport = [];
    }
  }

  async function startRepair() {
    try {
      repairing = true;
      repairLogs = ['Starting repair process...'];
      repairProgress = 0;
      
      setupRepairListeners();
      
      if (!selectedMC || !selectedFabric) {
        repairLogs = [...repairLogs, 'Looking for server configuration...'];
        
        try {
          const config = await window.electron.invoke('read-config', serverPath);
          
          if (config && config.version) {
            selectedMC = config.version;
            selectedFabric = config.fabric || 'latest';
            repairLogs = [...repairLogs, `Found Minecraft version: ${selectedMC}`];
            repairLogs = [...repairLogs, `Found Fabric version: ${selectedFabric}`];
          } else {
            repairLogs = [...repairLogs, 'Error: Missing version information in server configuration.'];
            throw new Error('Missing version information. Please configure server settings first.');
          }
        } catch (configErr) {
          repairLogs = [...repairLogs, `Error: ${configErr.message || 'Failed to load server configuration'}`];
          throw configErr;
        }
      }
      
      repairLogs = [...repairLogs, `Repairing server with Minecraft ${selectedMC} and Fabric ${selectedFabric}`];
      
      try {
        repairLogs = [...repairLogs, 'Sending repair request to server...'];
        
        await window.electron.invoke('repair-health', {
          targetPath: serverPath,
          mcVersion: selectedMC,
          fabricVersion: selectedFabric
        });
        
      } catch (repairErr) {
        repairLogs = [...repairLogs, `Error from server: ${repairErr.message || 'Unknown error during repair'}`];
        repairing = false;
      }
    } catch (err) {
      repairLogs = [...repairLogs, `Error: ${err.message || 'Unknown error during repair'}`];
      repairing = false;
    }
  }
  
  function setupRepairListeners() {
    window.electron.removeAllListeners('repair-progress');
    window.electron.removeAllListeners('repair-log');
    window.electron.removeAllListeners('repair-status');
    
    window.electron.on('repair-progress', (data) => {
      if (data && typeof data.percent === 'number') {
        repairProgress = data.percent;
        repairSpeed = data.speed || '0.00 MB/s';
      }
    });
    
    window.electron.on('repair-log', msg => {
      repairLogs = [...repairLogs, msg];
    });
    
    window.electron.on('repair-status', status => {
      if (status === 'done') {
        repairProgress = 100;
        setTimeout(() => {
          repairing = false;
          checkHealth();
        }, 1000);
      }
    });
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
    logger.info('Checking for version updates', {
      category: 'ui',
      data: {
        component: 'ServerControls',
        function: 'checkVersionUpdates',
        currentMcVersion,
        currentFabricVersion
      }
    });
    
    try {
      await refreshLatestVersions(currentMcVersion);
      
      logger.info('Version update check completed', {
        category: 'ui',
        data: {
          component: 'ServerControls',
          function: 'checkVersionUpdates',
          mcUpdateAvailable,
          fabricUpdateAvailable,
          latestMcVersion: $latestVersions.mc,
          latestFabricVersion: $latestVersions.fabric
        }
      });
    } catch (error) {
      logger.error('Failed to check version updates', {
        category: 'ui',
        data: {
          component: 'ServerControls',
          function: 'checkVersionUpdates',
          errorMessage: error.message
        }
      });
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

  async function loadInviteInfo() {
    inviteError = '';
    inviteWarning = '';
    inviteCopied = false;
    if (!serverPath) {
      inviteLink = '';
      inviteHostInput = '';
      return;
    }
    inviteStatus = 'loading';
    try {
      const result = await window.electron.invoke('get-management-invite-info', {
        serverPath,
        port: coercePort(managementPort) || undefined
      });
      if (result && result.success) {
        inviteLink = result.inviteLink || '';
        inviteHostInput = result.configuredHost || '';
        inviteWarning = result.usesPublicHost
          ? 'Public IPs can change. Use a static domain for a stable invite link.'
          : '';
      } else {
        inviteError = result?.error || 'Failed to load invite link';
      }
    } catch (error) {
      inviteError = error.message || 'Failed to load invite link';
    } finally {
      inviteStatus = 'idle';
    }
  }

  async function saveInviteHost() {
    if (!serverPath) return;
    inviteStatus = 'saving';
    inviteError = '';
    try {
      const result = await window.electron.invoke('set-management-invite-host', {
        serverPath,
        host: inviteHostInput
      });
      if (result && result.success) {
        await loadInviteInfo();
      } else {
        inviteError = result?.error || 'Failed to save invite host';
      }
    } catch (error) {
      inviteError = error.message || 'Failed to save invite host';
    } finally {
      inviteStatus = 'idle';
    }
  }

  async function regenerateInviteSecret() {
    if (!serverPath) return;
    inviteStatus = 'saving';
    inviteError = '';
    try {
      const result = await window.electron.invoke('regenerate-management-invite-secret', {
        serverPath
      });
      if (result && result.success) {
        await loadInviteInfo();
      } else {
        inviteError = result?.error || 'Failed to regenerate invite secret';
      }
    } catch (error) {
      inviteError = error.message || 'Failed to regenerate invite secret';
    } finally {
      inviteStatus = 'idle';
    }
  }

  async function copyInviteLink() {
    if (!inviteLink) return;
    try {
      if (navigator.clipboard && navigator.clipboard.writeText) {
        await navigator.clipboard.writeText(inviteLink);
      } else {
        const input = document.createElement('input');
        input.value = inviteLink;
        document.body.appendChild(input);
        input.select();
        document.execCommand('copy');
        document.body.removeChild(input);
      }
      inviteCopied = true;
      setTimeout(() => { inviteCopied = false; }, 1500);
    } catch {
      inviteError = 'Failed to copy invite link';
    }
  }
  function startServer() {
    logger.info('Starting Minecraft server', {
      category: 'ui',
      data: {
        component: 'ServerControls',
        function: 'startServer',
        serverPath,
        port,
        maxRam
      }
    });
    
    // Optimistic update: mark server as running immediately
    serverState.update(state => ({ ...state, status: 'Running' }));
    window.electron.invoke('start-server', { 
      targetPath: serverPath, 
      port: port, 
      maxRam: maxRam 
    }); 
  }

  function stopServer() {
    logger.info('Stopping Minecraft server', {
      category: 'ui',
      data: {
        component: 'ServerControls',
        function: 'stopServer'
      }
    });
    
    window.electron.invoke('stop-server')
      .then(() => {
        logger.debug('Server stop command sent successfully', {
          category: 'ui',
          data: {
            component: 'ServerControls',
            function: 'stopServer'
          }
        });
        
        // Force-enable inputs after the stop command is sent
        setTimeout(enableInputFields, 100);
        setTimeout(enableInputFields, 500);
      })
      .catch(error => {
        logger.error('Failed to stop server', {
          category: 'ui',
          data: {
            component: 'ServerControls',
            function: 'stopServer',
            errorMessage: error.message
          }
        });
      });
  }

  function killServer() {
    logger.warn('Force killing Minecraft server', {
      category: 'ui',
      data: {
        component: 'ServerControls',
        function: 'killServer'
      }
    });
    
    window.electron.invoke('kill-server')
      .then(() => {
        logger.debug('Server kill command sent successfully', {
          category: 'ui',
          data: {
            component: 'ServerControls',
            function: 'killServer'
          }
        });
        
        // Force-enable inputs after the kill command is sent
        setTimeout(enableInputFields, 100);
        setTimeout(enableInputFields, 500);
      })
      .catch(error => {
        logger.error('Failed to kill server', {
          category: 'ui',
          data: {
            component: 'ServerControls',
            function: 'killServer',
            errorMessage: error.message
          }
        });
      });
  }

  let statusHandler;
  let metricsHandler;

  // Handle visibility change
  function handleVisibilityChange() {
    isVisible = document.visibilityState === 'visible';
    if (isVisible) {
      // When tab becomes visible, check server status
      checkServerStatus();
    }
  }

  onMount(() => {
    logger.info('ServerControls component mounted', {
      category: 'ui',
      data: {
        component: 'ServerControls',
        function: 'onMount',
        serverPath,
        port,
        maxRam
      }
    });
    
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
    }, 120000); // Check every 2 minutes when visible (reduced from 30 seconds)

    // Initialize maintenance repair listeners
    setupRepairListeners();

    // Load settings first, then check server status
    (async () => {
      try {
        // Load saved settings
        const settingsResult = await window.electron.invoke('get-settings');
        if (settingsResult && settingsResult.success) {
          const { settings } = settingsResult;
          // Update local variables with settings
          if (settings.port !== undefined) {
            const parsedPort = coercePort(settings.port);
            if (parsedPort !== null) port = parsedPort;
          }
          if (settings.maxRam !== undefined) {
            const parsedMaxRam = coercePort(settings.maxRam);
            if (parsedMaxRam !== null) maxRam = parsedMaxRam;
          }
          if (settings.managementPort !== undefined) {
            const parsedManagementPort = coercePort(settings.managementPort);
            if (parsedManagementPort !== null) managementPort = parsedManagementPort;
          }
          if (settings.autoStartMinecraft !== undefined) autoStartMinecraft = settings.autoStartMinecraft;
          if (settings.autoStartManagement !== undefined) autoStartManagement = settings.autoStartManagement;
          // Update server state store with loaded values
          serverState.update(state => ({
            ...state,
            port,
            maxRam
          }));
        }
        // Initial status check
        await checkServerStatus();

        // Fetch latest version info for update notification
        await refreshLatestVersions(get(settingsStore).mcVersion);
        updateChecked = true;
        
        // Load management server status on mount (but don't override saved port setting)
        try {
          const result = await window.electron.invoke('get-management-server-status');
          if (result.success && result.status) {
            applyManagementStatus(result.status.isRunning ? 'running' : 'stopped');
            if (result.status.isRunning) {
              const statusPort = coercePort(result.status.port);
              if (statusPort !== null && statusPort !== coercePort(managementPort)) {
                managementPort = statusPort;
              }
            }
            connectedClients = result.status.clientCount || 0;
          }
        } catch (error) {
        }
        
        // Load configuration for maintenance
        if (serverPath) {
          try {
            const config = await window.electron.invoke('read-config', serverPath);
            if (config) {
              selectedMC = config.version;
              selectedFabric = config.fabric || 'latest';
            }
          } catch (error) {
          }
        }
        
        // Handle auto-start servers if enabled (only on actual app startup, not tab switches)
        if (!window.appStartupCompleted) {
          await runAutoStartOnce();
        }
      } catch (err) {
        // Failed to get settings or server status
      } finally {
        managementSettingsLoaded = true;
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
        applyManagementStatus('running');
        const statusPort = coercePort(data.port);
        if (statusPort !== null && statusPort !== coercePort(managementPort)) {
          managementPort = statusPort;
        }
        if (serverPath && managementSettingsLoaded) {
          void loadInviteInfo();
        }
      } else {
        applyManagementStatus('stopped');
        connectedClients = 0;
      }
    };
    
    window.electron.on('management-server-status', handleManagementServerStatus);

    return () => {
      window.electron.removeListener('management-server-status', handleManagementServerStatus);
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
    // Clean up maintenance repair listeners
    window.electron.removeAllListeners('repair-progress');
    window.electron.removeAllListeners('repair-log');
    window.electron.removeAllListeners('repair-status');
  });

  // Update server state when port or ram is changed
  function updateSettings() {
    logger.debug('Updating server settings', {
      category: 'ui',
      data: {
        component: 'ServerControls',
        function: 'updateSettings',
        port,
        maxRam,
        managementPort,
        autoStartMinecraft,
        autoStartManagement
      }
    });
    
    // Update local state
    serverState.update(state => ({
      ...state,
      port: port,
      maxRam: maxRam
    }));
    const normalizedPort = coercePort(port);
    const normalizedMaxRam = coercePort(maxRam);
    const normalizedManagementPort = coercePort(managementPort);
    // Save settings to electron store
    window.electron.invoke('update-settings', {
      port: normalizedPort ?? port,
      maxRam: normalizedMaxRam ?? maxRam,
      managementPort: normalizedManagementPort ?? managementPort,
      autoStartMinecraft: autoStartMinecraft,
      autoStartManagement: autoStartManagement
    }).catch((error) => {
      logger.error('Failed to save settings', {
        category: 'ui',
        data: {
          component: 'ServerControls',
          function: 'updateSettings',
          errorMessage: error.message
        }
      });
    });
  }
  
  async function runAutoStartOnce() {
    if (autoStartInProgress || window.appStartupCompleted) {
      return;
    }
    if (!validateServerPath(serverPath)) {
      pendingAutoStart = true;
      return;
    }
    autoStartInProgress = true;
    pendingAutoStart = false;
    try {
      await handleAutoStart();
      window.appStartupCompleted = true;
    } finally {
      autoStartInProgress = false;
    }
  }

  // Handle auto-start functionality
  async function handleAutoStart() {
    if (!validateServerPath(serverPath)) {
      return;
    }
    
    // Auto-start management server first if enabled
    if (autoStartManagement && managementServerStatus !== 'running' && managementServerStatus !== 'starting') {
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
    if (!validateServerPath(serverPath)) {
      logger.warn('Cannot start management server - invalid server path', {
        category: 'ui',
        data: {
          component: 'ServerControls',
          function: 'startManagementServer',
          serverPath
        }
      });
      return;
    }
    
    logger.info('Starting management server', {
      category: 'ui',
      data: {
        component: 'ServerControls',
        function: 'startManagementServer',
        managementPort,
        serverPath
      }
    });
    
    applyManagementStatus('starting');
    try {
      const result = await window.electron.invoke('start-management-server', {
        port: coercePort(managementPort) || managementPort,
        serverPath: serverPath
      });
      
      if (result.success) {
        applyManagementStatus('running');
        await loadInviteInfo();
        logger.info('Management server started successfully', {
          category: 'ui',
          data: {
            component: 'ServerControls',
            function: 'startManagementServer',
            managementPort
          }
        });
      } else {
        applyManagementStatus('stopped');
        logger.error('Failed to start management server', {
          category: 'ui',
          data: {
            component: 'ServerControls',
            function: 'startManagementServer',
            error: result.error
          }
        });
        errorMessage.set(`Failed to start management server: ${result.error}`);
        setTimeout(() => errorMessage.set(''), 5000);
      }
    } catch (error) {
      applyManagementStatus('stopped');
      logger.error('Error starting management server', {
        category: 'ui',
        data: {
          component: 'ServerControls',
          function: 'startManagementServer',
          errorMessage: error.message
        }
      });
      errorMessage.set(`Error starting management server: ${error.message}`);
      setTimeout(() => errorMessage.set(''), 5000);
    }
  }

  async function stopManagementServer() {
    logger.info('Stopping management server', {
      category: 'ui',
      data: {
        component: 'ServerControls',
        function: 'stopManagementServer'
      }
    });
    
    applyManagementStatus('stopping');
    try {
      const result = await window.electron.invoke('stop-management-server');

      if (result.success || result.forced) {
        applyManagementStatus('stopped');
        connectedClients = 0;
        if (result.forced) {
          logger.warn('Management server stop forced (timeout/active connections)', {
            category: 'ui',
            data: {
              component: 'ServerControls',
              function: 'stopManagementServer',
              reason: result.reason || 'timeout'
            }
          });
          errorMessage.set('Management server stop forced after timeout.');
          setTimeout(() => errorMessage.set(''), 5000);
        } else {
          logger.info('Management server stopped successfully', {
            category: 'ui',
            data: {
              component: 'ServerControls',
              function: 'stopManagementServer'
            }
          });
        }
      } else {
        applyManagementStatus('running');
        logger.error('Failed to stop management server', {
          category: 'ui',
          data: {
            component: 'ServerControls',
            function: 'stopManagementServer',
            error: result.error
          }
        });
        errorMessage.set(`Failed to stop management server: ${result.error}`);
        setTimeout(() => errorMessage.set(''), 5000);
      }
    } catch (error) {
      applyManagementStatus('running');
      logger.error('Error stopping management server', {
        category: 'ui',
        data: {
          component: 'ServerControls',
          function: 'stopManagementServer',
          errorMessage: error.message
        }
      });
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
          max="128" 
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
            on:change={updateSettings}
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
          <span>Share the invite link below with your clients.</span>
          <button class="dismiss-btn" on:click={dismissHelpText} title="Dismiss this message">×</button>
        </div>
      {/if}

      <div class="management-invite">
        <div class="invite-row">
          <label class="invite-label" for="invite-link-input">Invite link</label>
          <div class="invite-actions">
            <input
              id="invite-link-input"
              class="invite-input"
              type="text"
              readonly
              value={inviteLink}
              placeholder="Loading invite link..."
            />
            <button class="btn-compact" type="button" on:click={copyInviteLink} disabled={!inviteLink}>
              {inviteCopied ? 'Copied' : 'Copy'}
            </button>
            <button class="btn-compact" type="button" on:click={regenerateInviteSecret} disabled={inviteStatus === 'saving'}>
              Regenerate
            </button>
          </div>
          {#if inviteWarning}
            <div class="invite-warning">{inviteWarning}</div>
          {/if}
          {#if inviteError}
            <div class="invite-error">{inviteError}</div>
          {/if}
        </div>

        <div class="invite-row">
          <label class="invite-label" for="invite-host-input">Static host (optional)</label>
          <div class="invite-actions">
            <input
              id="invite-host-input"
              class="invite-input"
              type="text"
              bind:value={inviteHostInput}
              placeholder="mc.example.com"
              disabled={inviteStatus === 'saving'}
            />
            <button class="btn-compact" type="button" on:click={saveInviteHost} disabled={inviteStatus === 'saving'}>
              Save
            </button>
          </div>
        </div>
      </div>
    </div>
  </div>
  
  <!-- MAINTENANCE SECTION - Collapsible -->
  <div class="maintenance-compact">
    <div class="maintenance-header" role="button" tabindex="0" on:click={toggleMaintenance} on:keydown={(e) => e.key === 'Enter' && toggleMaintenance()}>
      <h4>🔧 Server Maintenance</h4>
      <div class="maintenance-toggle">
        <span class="toggle-icon" class:expanded={maintenanceExpanded}>
          {maintenanceExpanded ? '▼' : '▶'}
        </span>
        {#if healthReport.length > 0 && !maintenanceExpanded}
          <span class="issue-indicator">⚠️ {healthReport.length} issues</span>
        {:else if !maintenanceExpanded}
          <span class="status-indicator-small">Check components</span>
        {/if}
      </div>
    </div>
    
    {#if maintenanceExpanded}
      <div class="maintenance-content">
        <p class="maintenance-description">Check and repair essential server components: Java runtime, server jar, and Fabric (not world data or mods)</p>
        
        <div class="maintenance-actions">
          <button class="btn-compact check-button" on:click={checkHealth}>
            🔍 Check Components
          </button>
          
          {#if healthReport.length > 0}
            <span class="issues-found">⚠️ {healthReport.length} missing components</span>
            <button class="btn-compact repair-button" on:click={startRepair} disabled={repairing}>
              {repairing ? '🔄 Repairing...' : '🔧 Install Missing'}
            </button>
          {:else if healthReport.length === 0 && selectedMC}
            <span class="all-good">✅ All components ready</span>
          {/if}
        </div>
        
        {#if healthReport.length > 0}
          <div class="missing-files">
            <h5>Missing Components:</h5>
            <ul class="file-list">
              {#each healthReport as component (component)}
                <li class="missing-file">❌ {component}</li>
              {/each}
            </ul>
          </div>
        {/if}
        
        {#if repairing}
          <div class="repair-progress">
            <div class="progress-info">
              <span class="progress-percentage">{repairProgress}%</span>
              <span class="progress-speed">{repairSpeed}</span>
            </div>
            <div class="progress-bar">
              <div class="progress-fill" style="width: {repairProgress}%"></div>
            </div>
          </div>
          
          <div class="repair-logs">
            {#each repairLogs as log, index (index)}
              <div class="log-line">{log}</div>
            {/each}
          </div>
        {/if}
      </div>
    {/if}
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

  .management-invite {
    display: flex;
    flex-direction: column;
    gap: 0.75rem;
    margin-top: 0.75rem;
  }

  .invite-row {
    display: flex;
    flex-direction: column;
    gap: 0.35rem;
  }

  .invite-label {
    font-size: 0.85rem;
    color: #cbd5f5;
  }

  .invite-actions {
    display: flex;
    gap: 0.5rem;
    align-items: center;
    flex-wrap: wrap;
  }

  .invite-input {
    flex: 1 1 260px;
    min-width: 220px;
    background-color: #1f2937;
    color: #e5e7eb;
    border: 1px solid #374151;
    border-radius: 4px;
    padding: 0.35rem 0.5rem;
    font-size: 0.85rem;
  }

  .invite-warning {
    color: #fbbf24;
    font-size: 0.8rem;
  }

  .invite-error {
    color: #f87171;
    font-size: 0.8rem;
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

  /* Maintenance section styles */
  .maintenance-compact {
    background: rgba(30, 30, 30, 0.6);
    border: 1px solid #444;
    border-radius: 6px;
    padding: 0.75rem;
    margin-bottom: 0.75rem;
  }

  .maintenance-header {
    display: flex;
    justify-content: space-between;
    align-items: center;
    cursor: pointer;
    padding-bottom: 0.375rem;
    border-bottom: 1px solid #f59e0b;
    transition: all 0.2s ease;
  }

  .maintenance-header:hover {
    background: rgba(245, 158, 11, 0.05);
    border-radius: 4px;
    margin: -0.25rem;
    padding: 0.625rem 0.25rem;
  }

  .maintenance-header h4 {
    margin: 0;
    font-size: 0.95rem;
    color: #f59e0b;
  }

  .maintenance-toggle {
    display: flex;
    align-items: center;
    gap: 0.5rem;
    font-size: 0.75rem;
  }

  .toggle-icon {
    color: #f59e0b;
    font-size: 0.7rem;
    transition: transform 0.2s ease;
  }

  .toggle-icon.expanded {
    transform: rotate(0deg);
  }

  .issue-indicator {
    background: rgba(239, 68, 68, 0.15);
    color: #ef4444;
    padding: 0.125rem 0.375rem;
    border-radius: 3px;
    font-size: 0.65rem;
    font-weight: 600;
  }

  .status-indicator-small {
    color: #9ca3af;
    font-size: 0.65rem;
  }

  .maintenance-content {
    margin-top: 0.5rem;
    padding-top: 0.5rem;
  }

  .maintenance-description {
    color: #9ca3af;
    font-size: 0.75rem;
    margin: 0 0 0.75rem 0;
    line-height: 1.4;
  }

  .maintenance-actions {
    display: flex;
    align-items: center;
    gap: 0.75rem;
    margin-bottom: 0.75rem;
    flex-wrap: wrap;
  }

  .check-button {
    background-color: #3b82f6 !important;
    color: white !important;
    width: auto !important;
    min-width: 100px !important;
  }

  .check-button:hover:not(:disabled) {
    background-color: #2563eb !important;
  }

  .repair-button {
    background-color: #f59e0b !important;
    color: white !important;
    width: auto !important;
    min-width: 110px !important;
  }

  .repair-button:hover:not(:disabled) {
    background-color: #d97706 !important;
  }

  .issues-found {
    color: #ef4444;
    font-size: 0.75rem;
    font-weight: 600;
  }

  .all-good {
    color: #10b981;
    font-size: 0.75rem;
    font-weight: 600;
  }

  .missing-files {
    background: rgba(239, 68, 68, 0.1);
    border: 1px solid rgba(239, 68, 68, 0.2);
    border-radius: 4px;
    padding: 0.5rem;
    margin-bottom: 0.75rem;
  }

  .missing-files h5 {
    margin: 0 0 0.375rem 0;
    color: #ef4444;
    font-size: 0.8rem;
  }

  .file-list {
    list-style: none;
    padding: 0;
    margin: 0;
    font-family: monospace;
    font-size: 0.7rem;
  }

  .missing-file {
    color: #ef4444;
    margin-bottom: 0.25rem;
    padding: 0.125rem 0;
  }

  .repair-progress {
    background: rgba(16, 185, 129, 0.1);
    border: 1px solid rgba(16, 185, 129, 0.2);
    border-radius: 4px;
    padding: 0.5rem;
    margin-bottom: 0.75rem;
  }

  .progress-info {
    display: flex;
    justify-content: space-between;
    margin-bottom: 0.375rem;
    font-size: 0.75rem;
  }

  .progress-percentage {
    color: #10b981;
    font-weight: 600;
  }

  .progress-speed {
    color: #9ca3af;
  }

  .progress-bar {
    width: 100%;
    height: 8px;
    background: rgba(17, 24, 39, 0.8);
    border-radius: 4px;
    overflow: hidden;
  }

  .progress-fill {
    height: 100%;
    background: #10b981;
    transition: width 0.3s ease;
    border-radius: 4px;
  }

  .repair-logs {
    background: rgba(17, 24, 39, 0.8);
    border: 1px solid #374151;
    border-radius: 4px;
    padding: 0.5rem;
    max-height: 150px;
    overflow-y: auto;
    font-family: monospace;
    font-size: 0.65rem;
  }

  .log-line {
    color: #d1d5db;
    padding: 0.125rem 0;
    border-bottom: 1px solid rgba(55, 65, 81, 0.5);
  }

  .log-line:last-child {
    border-bottom: none;
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

    .maintenance-actions {
      flex-direction: column;
      align-items: stretch;
      gap: 0.5rem;
    }

    .maintenance-header:hover {
      margin: -0.125rem;
      padding: 0.5rem 0.125rem;
    }
  }
</style>

