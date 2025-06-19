<script lang="ts">
  import { onMount, onDestroy } from 'svelte';
  import { get } from 'svelte/store';
  import { createEventDispatcher } from 'svelte';  import { 
    errorMessage, 
    successMessage,
    searchKeyword,
    searchResults,
    minecraftVersion,
    loaderType,
    installingModIds,
    filterMinecraftVersion,
    filterModLoader,
    serverManagedFiles,
    modToInstall,
    currentDependencies,
    removeServerManagedFiles
  } from '../../stores/modStore.js';
  import { searchMods } from '../../utils/mods/modAPI.js';
  import { installedModIds, installedModInfo } from '../../stores/modStore.js';
  import { initDownloadManager } from '../../utils/mods/modDownloadManager.js';
  import DownloadProgress from '../mods/components/DownloadProgress.svelte';
  import ModDependencyModal from '../mods/components/ModDependencyModal.svelte';  import ClientModList from './ClientModList.svelte';
  import ClientManualModList from './ClientManualModList.svelte';
  import ClientModStatus from './ClientModStatus.svelte';
  import ModSearch from '../mods/components/ModSearch.svelte';
  import ModDropZone from '../mods/components/ModDropZone.svelte';
  import { uploadDroppedMods } from '../../utils/directFileUpload.js';
  import { checkModDependencies, showDependencyModal, installWithDependencies } from '../../utils/mods/modDependencyHelper.js';
  import { checkDependencyCompatibility } from '../../utils/mods/modCompatibility.js';
  import { safeInvoke } from '../../utils/ipcUtils.js';
  import {
    connectionStatus,
    serverMods,
    requiredMods,
    optionalMods,
    allClientMods,
    installedModsInfo,
    modSyncStatus,
    isLoadingMods,
    lastModCheck,
    acknowledgedDeps,
    updateServerManagedFiles
  } from '../../stores/clientModManager.js';
  import {
    loadInstalledInfo,
    loadModsFromServer,
    checkModSynchronization,
    refreshInstalledMods,
    downloadRequiredMods,
    acknowledgeAllDependencies,
    downloadOptionalMods,
    downloadSingleOptionalMod,
    handleModToggle,
    handleModDelete,
    handleServerModRemoval,
    handleDependencyAcknowledgment,
    updateServerMod
  } from '../../utils/clientMods.js';

  // Types
  interface Instance {
    serverIp?: string;
    serverPort?: string;
    path?: string;
    clientId?: string;
    clientName?: string;
  }  interface ClientMod {
    fileName: string;
    size?: number;
    lastModified?: string;
    location: string;
    required?: boolean;
    checksum?: string;
    downloadUrl?: string;
    name?: string;
    versionNumber?: string;
    projectId?: string;
    needsRemoval?: boolean;
    removalReason?: string;
    removalAction?: string;
  }  interface ModSyncStatus {
    synchronized: boolean;
    needsDownload?: number;
    needsOptionalDownload?: number;
    totalRequired?: number;
    totalOptional?: number;
    totalPresent?: number;
    totalOptionalPresent?: number;
    missingMods?: string[];
    missingOptionalMods?: string[];
    outdatedMods?: Array<{
      fileName: string;
      name: string;
      currentVersion: string;
      newVersion: string;
    }>;
    outdatedOptionalMods?: Array<{
      fileName: string;
      name: string;
      currentVersion: string;
      newVersion: string;
    }>;
    presentEnabledMods?: string[];
    presentDisabledMods?: string[];
    // New response structure
    requiredRemovals?: Array<{
      fileName: string;
      reason: string;
    }>;
    optionalRemovals?: Array<{
      fileName: string;
      reason: string;
    }>;
    acknowledgments?: Array<{
      fileName: string;
      reason: string;
    }>;
    // Legacy structure for backward compatibility (temporary)
    clientModChanges?: {
      updates?: Array<{
        name: string;
        fileName: string;
        currentVersion: string;
        serverVersion: string;
        action: string;
      }>;      removals?: Array<{
        name: string;
        fileName: string;
        reason: string;
        action: string;
        wasRequired?: boolean;
      }>;
      newDownloads?: string[];
    };
  }

  // State and helpers moved to dedicated store

  // Props
  export let instance: Instance | null = null; // Client instance
  // Create event dispatcher
  const dispatch = createEventDispatcher();
  // Listen for refresh events from parent
  async function handleRefreshFromParent() {
    await refreshMods();
  }
  // Export the refresh function so parent can call it
  export { handleRefreshFromParent as refreshFromDashboard };
  
  // Export the acknowledgment function so parent can call it
  export { acknowledgeAllDependencies };
  // Core state now provided by clientModManager store
  
  // Client mod finding state
  let activeTab: string = 'installed-mods'; // 'installed-mods' or 'find-mods'
  let minecraftVersionOptions = [get(minecraftVersion) || '1.20.1'];
  let filterType = 'client';
  let downloadManagerCleanup;
  let unsubscribeInstalledInfo;
  let previousPath: string | null = null;
  let manualModsRefreshTrigger: number = 0; // Trigger to refresh manual mods list
  let isCheckingModSync = false; // Guard to prevent reactive loops
  let lastCheckModSyncCall = 0; // Track the most recent call
  
  // keep track of which fileNames we've acknowledged is managed by store
  $: displayRequiredMods = (() => {
    // Don't filter by acknowledgedDeps here - that's handled in the acknowledgment button logic
    // Only filter out mods that are marked for safe removal
    let displayMods = $requiredMods.filter(m => {
      // Check if this mod is marked for removal (can be safely removed)
      const isMarkedForRemoval = $modSyncStatus?.requiredRemovals?.some(removal =>
        removal.fileName.toLowerCase() === m.fileName.toLowerCase()
      );
      
      // Show the mod unless it's marked for safe removal
      return !isMarkedForRemoval;
    });
    
    // FIX: Replace server target versions with actual current versions from installed mods
    displayMods = displayMods.map(serverMod => {
      // Find the actual installed version of this mod
      const installedMod = $installedModsInfo.find(installed =>
        installed.fileName === serverMod.fileName
      );
      
      if (installedMod && installedMod.versionNumber) {
        // Use the actual current version, not the server target version
        return {
          ...serverMod,
          versionNumber: installedMod.versionNumber,
          name: installedMod.name || serverMod.name, // Also use the clean name if available
        };
      }
      
      return serverMod; // Keep original if no installed version found
    });
      // Add mods that need removal from the new response structure
    if ($modSyncStatus?.requiredRemovals) {

      for (const removal of $modSyncStatus.requiredRemovals) {
        // Check if this mod is not already in the display list
        const existsInDisplay = displayMods.some(mod => mod.fileName.toLowerCase() === removal.fileName.toLowerCase());
        
        if (!existsInDisplay) {
          // Create a mod object for the removal and add it to display list
          displayMods.push({
            fileName: removal.fileName,
            name: removal.fileName,
            location: 'client', // It exists on client
            size: 0, // We don't know the size
            lastModified: new Date().toISOString(),
            required: true, // This was a required mod
            checksum: '',
            downloadUrl: '',
            projectId: null,
            versionNumber: null,
            needsRemoval: true,
            removalReason: removal.reason,
            removalAction: 'remove_needed'
          });
        }
      }
    }
      // Add mods that need acknowledgment from the new response structure
    if ($modSyncStatus?.acknowledgments) {
        for (const ack of $modSyncStatus.acknowledgments) {
        // Check if this mod is not already in the display list and not already acknowledged
        const existsInDisplay = displayMods.some(mod => mod.fileName.toLowerCase() === ack.fileName.toLowerCase());
        const isAlreadyAcknowledged = $acknowledgedDeps.has(ack.fileName.toLowerCase());
        
        if (!existsInDisplay && !isAlreadyAcknowledged) {
          // Create a mod object for the acknowledgment and add it to display list
          displayMods.push({
            fileName: ack.fileName,
            name: ack.fileName,
            location: 'client', // It exists on client
            size: 0, // We don't know the size
            lastModified: new Date().toISOString(),
            required: true, // Marked as required for acknowledgment
            checksum: '',
            downloadUrl: '',
            projectId: null,
            versionNumber: null,
            needsRemoval: false,            removalReason: ack.reason,            removalAction: 'acknowledge_dependency'
          });
        }
      }
    }
    
    return displayMods;
  })();  // Computed property for optional mods - show all except those that can be safely removed
  $: displayOptionalMods = (() => {
    // Don't filter by acknowledgedDeps here - that's handled in the acknowledgment button logic
    // Only filter out mods that are marked for safe removal
    let mods = $optionalMods.filter(m => {
      // Check if this mod is marked for removal (can be safely removed)
      const isMarkedForRemoval = $modSyncStatus?.optionalRemovals?.some(removal =>
        removal.fileName.toLowerCase() === m.fileName.toLowerCase()
      );
      
      // Show the mod unless it's marked for safe removal
      return !isMarkedForRemoval;
    });
    
    // FIX: Replace server target versions with actual current versions from installed mods
    mods = mods.map(serverMod => {
      // Find the actual installed version of this mod
      const installedMod = $installedModsInfo.find(installed =>
        installed.fileName === serverMod.fileName
      );
      
      if (installedMod && installedMod.versionNumber) {
        // Use the actual current version, not the server target version
        return {
          ...serverMod,
          versionNumber: installedMod.versionNumber,
          name: installedMod.name || serverMod.name, // Also use the clean name if available
        };
      }
      
      return serverMod; // Keep original if no installed version found
    });// Add mods that need removal from the new response structure
    if ($modSyncStatus?.optionalRemovals) {

      for (const removal of $modSyncStatus.optionalRemovals) {
        // Check if this mod is not already in the display list
        const existingIndex = mods.findIndex(m => m.fileName.toLowerCase() === removal.fileName.toLowerCase());
        
        if (existingIndex >= 0) {
          // Update existing mod to show removal status
          mods[existingIndex] = {
            ...mods[existingIndex],
            needsRemoval: true,
            removalReason: removal.reason,
            removalAction: 'remove_needed'
          };
        } else {
          // Create a new mod object for the removal and add it to display list
          mods.push({
            fileName: removal.fileName,
            name: removal.fileName,
            location: 'client', // It exists on client
            size: 0, // We don't know the size
            lastModified: new Date().toISOString(),
            required: false, // This is an optional mod
            checksum: '',
            downloadUrl: '',
            projectId: null,
            versionNumber: 'Unknown',
            needsRemoval: true,
            removalReason: removal.reason,
            removalAction: 'remove_needed'
          });
        }
      }
    }
    
    return mods;
  })();  // Computed property to filter out already acknowledged mods from acknowledgments
  $: pendingAcknowledgments = (() => {
    if (!$modSyncStatus?.acknowledgments) return [];

    return $modSyncStatus.acknowledgments.filter(ack =>
      !$acknowledgedDeps.has(ack.fileName.toLowerCase())
    );
  })();

  // Function to load acknowledged dependencies from persistent storage
  async function loadAcknowledgedDependencies() {
    if (!instance?.path) return;
    
    try {
      const result = await window.electron.invoke('load-expected-mod-state', {
        clientPath: instance.path
      });
        if (result.success && result.acknowledgedDependencies) {
        acknowledgedDeps.set(
          new Set(result.acknowledgedDependencies.map(dep => dep.toLowerCase()))
        );
      }
    } catch (error) {
    }
  }

  // Connect to server and get mod information
  onMount(() => {
    downloadManagerCleanup = initDownloadManager();
    if (instance?.path) {
      // Populate local mod status even if not connected to a server
      refreshInstalledMods();
      
      // Load acknowledged dependencies from persistent storage
      loadAcknowledgedDependencies();
    }
    unsubscribeInstalledInfo = installedModInfo.subscribe(() => {
      // Only check mod synchronization if we're not already in the middle of checking
      // This prevents reactive loops that could cause the spam of log messages
      if (!isCheckingModSync) {
        checkModSynchronization();
      }
    });
    // Initialize filter stores for client mod search
    if (!get(filterMinecraftVersion)) {
      filterMinecraftVersion.set(get(minecraftVersion) || '1.20.1');
    }
    if (!get(filterModLoader)) {
      filterModLoader.set(get(loaderType) || 'fabric');
    }    if (instance && instance.serverIp && instance.serverPort) {
      // On initial load, do a fresh mod synchronization check instead of just loading server info
      // This ensures we catch any mods that need removal
      (async () => {
        await loadModsFromServer();
        await checkModSynchronization(); // This will properly detect removal needs
      })();
        
      // Set up periodic mod checking - reduced frequency to prevent flashing
      const interval = setInterval(loadModsFromServer, 5 * 60 * 1000); // Check every 5 minutes instead of 30 seconds
      
      return () => {
        clearInterval(interval);
        if (downloadManagerCleanup) downloadManagerCleanup();
      };
    }
  });

  onDestroy(() => {
    if (downloadManagerCleanup) downloadManagerCleanup();
    if (unsubscribeInstalledInfo) unsubscribeInstalledInfo();
  });  // Refresh installed mods when the instance path changes
  $: if (instance?.path && instance.path !== previousPath) {
    previousPath = instance.path;
    refreshInstalledMods();
  }

  // Keep filters in sync with the selected Minecraft version
  $: {
    if ($minecraftVersion) {
      filterMinecraftVersion.set($minecraftVersion);
      if (!minecraftVersionOptions.includes($minecraftVersion)) {
        minecraftVersionOptions = [$minecraftVersion, ...minecraftVersionOptions.filter(v => v !== $minecraftVersion)];
      }
    }  }

  // Reload installed mod info and update synchronization status
  async function refreshMods() {
    await loadModsFromServer(instance);
    await refreshInstalledMods(instance);
    successMessage.set('Mod list refreshed');
    setTimeout(() => successMessage.set(''), 3000);
  }

  // Handle file drop for adding mods directly
  async function handleDroppedFiles(event) {
    const { files } = event.detail;

    if (files && files.length > 0) {
      try {
        successMessage.set(`Processing ${files.length} files...`);

        const result = await uploadDroppedMods(files, instance?.path);

        if (result.success) {
          successMessage.set(`Successfully added ${result.count} mods`);

          await refreshInstalledMods();
        } else {
          errorMessage.set(`Failed to add mods: ${result.failed.join(', ')}`);
        }
      } catch (error) {
        errorMessage.set(`Failed to process files: ${error.message || 'Unknown error'}`);
      }
    }  }
  // Handle mod enable/disable for optional mods handled via utility
  // Delete a mod from the client
  // Mod deletion and server removal handled via utilities
  // Dependency acknowledgment handled via utility
  
  // Client mod search functionality
  async function searchClientMods() {
    if (!get(searchKeyword).trim()) {
      searchResults.set([]);
      return;
    }

    // Set environment type for client mods
    await searchMods({ 
      sortBy: 'relevance', 
      environmentType: 'client' 
    });
  }

  // Install a mod to the client instance
  async function installClientMod(mod, versionId = null, customPath = null) {
    const pathToUse = customPath || instance.path;
    if (!pathToUse) {
      errorMessage.set('No client path configured');
      setTimeout(() => errorMessage.set(''), 5000);
      return;
    }

    installingModIds.update(ids => {
      ids.add(mod.id);
      return ids;
    });

    try {
      const isUpdate = mod.forceReinstall || $installedModIds.has(mod.id);
      const modData = {
        id: mod.id,
        name: mod.name,
        title: mod.title || mod.name,
        selectedVersionId: versionId,
        source: 'modrinth',
        loader: get(loaderType) || 'fabric',
        version: get(minecraftVersion) || '1.20.1',
        clientPath: pathToUse,
        forceReinstall: isUpdate
      };

      const result = await window.electron.invoke('install-client-mod', modData);

      if (result && result.success) {
        successMessage.set(`Successfully installed ${mod.name} to client`);
        setTimeout(() => successMessage.set(''), 5000);

        installedModIds.update(ids => {
          ids.add(mod.id);
          return new Set(ids);
        });
        installedModInfo.update(info => {
          const filtered = info.filter(m => m.projectId !== mod.id);
          return [
            ...filtered,
            {
              fileName: result.fileName,
              projectId: mod.id,
              versionId: result.versionId,
              versionNumber: result.version,
              source: 'modrinth'
            }
          ];
        });

        await refreshInstalledMods();
      } else {
        throw new Error(result?.error || 'Installation failed');
      }
    } catch (err) {
      errorMessage.set(`Failed to install ${mod.name}: ${err.message}`);
      setTimeout(() => errorMessage.set(''), 5000);
    } finally {
      installingModIds.update(ids => {
        ids.delete(mod.id);
        return ids;
      });
    }  }

  // Wrapper used by installWithDependencies for client installs
  async function clientInstallFn(mod, path) {
    try {
      await installClientMod(mod, mod.selectedVersionId, path);
      return true;
    } catch (error) {
      return false;
    }
  }
  function switchTab(tab) {
    activeTab = tab;
    if (tab === 'installed-mods') {
      refreshInstalledMods();
    }
    if (tab === 'find-mods') {
      // Refresh installed mod info when switching to find-mods tab
      loadInstalledInfo();
      if (get(searchResults).length === 0 && get(searchKeyword)) {
        searchClientMods();
      }
    }  }

  // Install selected mod and its dependencies using helper
  async function handleInstallWithDependencies() {
    try {
      const result = await installWithDependencies(instance?.path, clientInstallFn);

      if (!result) {
        const mod = get(modToInstall);
        if (mod && mod.id) {
          installingModIds.update(ids => {
            ids.delete(mod.id);
            return ids;
          });
        }

        const dependencies = get(currentDependencies);
        if (dependencies && dependencies.length > 0) {
          for (const dep of dependencies) {
            if (dep.projectId) {
              installingModIds.update(ids => {
                ids.delete(dep.projectId);
                return ids;
              });
            }
          }
        }
      }
    } catch (error) {
      errorMessage.set(`Failed to install dependencies: ${error.message || 'Unknown error'}`);
      installingModIds.set(new Set());
    }
  }
  // Handle mod installation with dependency checks
  async function handleInstallMod(event) {
    const { mod, versionId } = event.detail;
    const ver = versionId || mod.selectedVersionId;    // Refresh installed mod info so dependency checks see all current mods
    await loadInstalledInfo();
    
    // Get fresh installed mod info for accurate dependency checking
    const freshInstalledInfo = get(installedModInfo);

    let modForInstall;
    if (mod.fileName && mod.projectId && !mod.id) {
      modForInstall = {
        id: mod.projectId,
        name: mod.name || mod.fileName.replace(/\.jar$/i, ''),
        title: mod.name || mod.fileName.replace(/\.jar$/i, ''),
        forceReinstall: true,
        source: 'modrinth'
      };
    } else {
      modForInstall = { ...mod, source: mod.source || 'modrinth' };
    }

    if (ver) {
      modForInstall.selectedVersionId = ver;
    }

    installingModIds.update(ids => {
      ids.add(modForInstall.id);
      return ids;
    });

    try {
      const dependencies = await checkModDependencies(modForInstall);
      let compatibilityIssues = [];

      try {
        if (ver) {
          const versionInfo = await safeInvoke('get-version-info', {
            modId: modForInstall.id,
            versionId: ver,
            source: modForInstall.source,
            loader: get(loaderType),
            gameVersion: get(minecraftVersion)
          });          if (versionInfo && versionInfo.dependencies && versionInfo.dependencies.length > 0) {
            compatibilityIssues = await checkDependencyCompatibility(versionInfo.dependencies, modForInstall.id, freshInstalledInfo);
          }
        }
      } catch (compatErr) {
      }

      if ((dependencies && dependencies.length > 0) || compatibilityIssues.length > 0) {
        if (compatibilityIssues.length > 0) {
          dependencies.push(
            ...compatibilityIssues.map(issue => ({
              projectId: issue.dependency.projectId,
              name: `${issue.dependency.name} (${issue.message})`,
              dependencyType: 'compatibility',
              versionRequirement: issue.dependency.versionRequirement,
              currentVersionId: issue.dependency.currentVersionId,
              requiredVersion: issue.requiredVersion
            }))
          );
        }

        showDependencyModal(modForInstall, dependencies);

        installingModIds.update(ids => {
          ids.delete(modForInstall.id);
          return ids;
        });
        return;
      }

      await installClientMod(modForInstall, ver);
    } catch (err) {
      errorMessage.set(`Failed to install ${modForInstall.name}: ${err.message}`);
      setTimeout(() => errorMessage.set(''), 5000);
      installingModIds.update(ids => {
        ids.delete(modForInstall.id);
        return ids;      });
    }
  }
  // Update an individual server-managed mod
  // Update server-managed mods handled via utility

  // Enhance mod data with clean names from JAR files  // ...existing code...
</script>

<div class="client-mod-manager">
  <DownloadProgress />
  <ModDependencyModal on:install={handleInstallWithDependencies} />
  <div class="mod-manager-header">
    <h2>Client Mods</h2>
    <div class="connection-status">
      {#if $connectionStatus === 'connected'}
        <span class="status connected">✅ Connected to Server</span>
      {:else}
        <span class="status disconnected">❌ Disconnected from Server</span>
      {/if}
      {#if $lastModCheck}
        <span class="last-check">Last updated: {$lastModCheck.toLocaleTimeString()}</span>
      {/if}
    </div>    <div class="mod-actions">
      <button class="refresh-button" on:click={refreshMods} disabled={$isLoadingMods}>
        {$isLoadingMods ? '⏳ Loading...' : '🔄 Refresh'}
      </button>
      
      {#if modSyncStatus && !modSyncStatus.synchronized}
        <!-- Use same logic as Play tab for consistent button text -->
        {#if modSyncStatus.needsDownload > 0}
          <button class="download-button" on:click={downloadRequiredMods}>
            📥 Download Required Mods ({modSyncStatus.needsDownload})
          </button>        {:else}
          {@const actualRemovals = [...(modSyncStatus.requiredRemovals || []), ...(modSyncStatus.optionalRemovals || [])]}
          {@const acknowledgments = pendingAcknowledgments || []}
          
          {#if actualRemovals.length > 0}
            <button class="download-button" on:click={downloadRequiredMods}>
              🔄 Apply Mod Changes (Remove {actualRemovals.length} mod{actualRemovals.length > 1 ? 's' : ''})
            </button>          {:else if acknowledgments.length > 0}
            <button class="download-button" on:click={acknowledgeAllDependencies}>
              ✓ Acknowledge Dependencies ({acknowledgments.length})
            </button>
          {:else}
            <button class="download-button" on:click={downloadRequiredMods}>
              🔄 Synchronize Mods
            </button>
          {/if}
        {/if}
      {/if}
    </div>
  </div>

  <!-- Tab Navigation -->
  <div class="tab-navigation">
    <button
      class="tab {activeTab === 'installed-mods' ? 'active' : ''}"
      on:click={() => switchTab('installed-mods')}
    >
      Installed Mods
    </button>
    <button 
      class="tab {activeTab === 'find-mods' ? 'active' : ''}"
      on:click={() => switchTab('find-mods')}
    >
      Find & Install Mods
    </button>
  </div>

  <div class="mod-content">
    {#if activeTab === 'installed-mods'}
      <!-- Original server mod synchronization content -->
      {#if $connectionStatus === 'disconnected'}
        <div class="connection-error">
          <h3>⚠️ Cannot Connect to Server</h3>
          <p>Make sure the management server is running and accessible.</p>
          <button class="retry-button" on:click={loadModsFromServer}>
            🔄 Retry Connection
          </button>
        </div>
      {:else if $isLoadingMods && !$serverMods.length}
        <div class="loading">
          <h3>🔄 Loading Mods...</h3>
          <p>Fetching mod information from server...</p>
        </div>
      {:else}        <!-- Mod Status Overview -->        <ClientModStatus
          {modSyncStatus}
          requiredModsCount={$requiredMods.length}
          optionalModsCount={displayOptionalMods.length}
          {pendingAcknowledgments}
          on:download-required={downloadRequiredMods}
          on:download-optional={downloadOptionalMods}
          on:refresh={refreshMods}
          on:acknowledge-all-dependencies={acknowledgeAllDependencies}
        />

        <!-- Mod Lists -->
        <div class="mod-sections">
          <!-- Required Mods Section -->
          <div class="mod-section">
            <h3>Required Mods</h3>
            <p class="section-description">
              These mods are required by the server and cannot be disabled.
            </p>          <ClientModList
            mods={displayRequiredMods}
            type="required"
            {modSyncStatus}
            serverManagedFiles={$serverManagedFiles}
            on:download={downloadRequiredMods}
            on:remove={(e) => handleServerModRemoval(e.detail.fileName)}
            on:acknowledge={(e) => handleDependencyAcknowledgment(e.detail.fileName)}
            on:updateMod={updateServerMod}
          />
          </div>

          <!-- Optional Mods Section -->
          {#if displayOptionalMods.length > 0}
            <div class="mod-section">
              <h3>Optional Mods</h3>
              <p class="section-description">
                These mods are available but not required. You can enable or disable them before playing.
              </p>          <ClientModList
            mods={displayOptionalMods}
            type="optional"
            {modSyncStatus}
            serverManagedFiles={$serverManagedFiles}
            on:toggle={(e) => handleModToggle(e.detail.fileName, e.detail.enabled)}
            on:download={downloadOptionalMods}
            on:downloadSingle={(e) => downloadSingleOptionalMod(e.detail.mod)}
            on:delete={(e) => handleModDelete(e.detail.fileName)}
            on:updateMod={updateServerMod}
          />
        </div>
      {/if}          <!-- Client Downloaded Mods Section -->
          <div class="mod-section">
            <h3>Client Downloaded Mods</h3>
          <p class="section-description">
            Mods installed by you (not synced from server).
          </p>
          {#if $errorMessage}            <p class="error-message">
              {$errorMessage} Ensure your client path contains a <code>mods</code> directory.
            </p>
          {/if}          <ClientManualModList
            clientPath={instance?.path || ''}
            refreshTrigger={manualModsRefreshTrigger}
            modSyncStatus={modSyncStatus}
            on:toggle={(e) => handleModToggle(e.detail.fileName, e.detail.enabled)}
            on:delete={(e) => handleModDelete(e.detail.fileName)}
            on:install={handleInstallMod}
          />
          </div>
        </div>

        <!-- ModDropZone at the bottom -->
        <ModDropZone on:filesDropped={handleDroppedFiles} />
      {/if}
    {:else if activeTab === 'find-mods'}
      <!-- Client mod finding and installation -->
      <div class="mod-search-section">
        <ModSearch
          on:install={handleInstallMod}
          bind:filterType
          {minecraftVersionOptions}
          serverPath={instance?.path || ""}
          serverManagedSet={$serverManagedFiles}
        />
      </div>
    {/if}
  </div>
</div>

<style>
  .client-mod-manager {
    width: 100%;
    max-width: 1200px;
    margin: 0 auto;
    padding: 1rem;
  }

  .mod-manager-header {
    display: flex;
    flex-direction: column;
    gap: 1rem;
    margin-bottom: 2rem;
    padding: 1rem;
    background-color: #1f2937;
    border-radius: 8px;
    border: 1px solid #374151;
  }

  .mod-manager-header h2 {
    color: white;
    margin: 0;
    font-size: 1.5rem;
  }

  .connection-status {
    display: flex;
    flex-direction: column;
    gap: 0.5rem;
  }

  .status {
    font-size: 0.9rem;
    font-weight: 500;
  }

  .status.connected {
    color: #10b981;
  }

  .status.disconnected {
    color: #ef4444;
  }

  .last-check {
    font-size: 0.8rem;
    color: #9ca3af;
  }

  .mod-actions {
    display: flex;
    gap: 1rem;
    flex-wrap: wrap;
  }
  .refresh-button, .download-button, .retry-button {
    padding: 0.5rem 1rem;
    border: none;
    border-radius: 6px;
    font-weight: 500;
    cursor: pointer;
    transition: background-color 0.2s;
  }

  .refresh-button {
    background-color: #374151;
    color: white;
  }

  .refresh-button:hover:not(:disabled) {
    background-color: #4b5563;
  }

  .refresh-button:disabled {
    opacity: 0.5;
    cursor: not-allowed;
  }
  .download-button {
    background-color: #3b82f6;
    color: white;
  }

  .download-button:hover {
    background-color: #2563eb;
  }

  .retry-button {
    background-color: #f59e0b;
    color: white;
  }

  .retry-button:hover {
    background-color: #d97706;
  }

  .mod-content {
    min-height: 400px;
  }

  .connection-error, .loading {
    text-align: center;
    padding: 3rem 1rem;
    background-color: #1f2937;
    border-radius: 8px;
    border: 1px solid #374151;
  }

  .connection-error h3, .loading h3 {
    color: white;
    margin-bottom: 1rem;
  }

  .connection-error p, .loading p {
    color: #9ca3af;
    margin-bottom: 1.5rem;
  }

  .mod-sections {
    display: flex;
    flex-direction: column;
    gap: 2rem;
  }

  .mod-section {
    background-color: #1f2937;
    border-radius: 8px;
    border: 1px solid #374151;
    padding: 1.5rem;
  }

  .mod-section h3 {
    color: white;
    margin: 0 0 0.5rem 0;
    font-size: 1.25rem;
  }

  .section-description {
    color: #9ca3af;
    font-size: 0.9rem;
    margin-bottom: 1rem;
  }

  .tab-navigation {
    display: flex;
    gap: 1rem;
    margin-bottom: 2rem;
  }

  .tab {
    padding: 0.5rem 1rem;
    border: none;
    border-radius: 6px;
    font-weight: 500;
    cursor: pointer;
    transition: background-color 0.2s;
  }

  .tab.active {
    background-color: #3b82f6;
    color: white;
  }
  .mod-search-section {
    padding: 1.5rem;
    background-color: #1f2937;
    border-radius: 8px;
    border: 1px solid #374151;
  }

  .error-message {
    color: #ef4444;
    margin-bottom: 1rem;
  }

</style>
