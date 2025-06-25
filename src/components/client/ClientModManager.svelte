<script lang="ts">
  import { onMount, onDestroy } from 'svelte';
  import { get } from 'svelte/store';
  import {
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
    currentDependencies
  } from '../../stores/modStore.js';
  import { searchMods } from '../../utils/mods/modAPI.js';
  import { installedModIds, installedModInfo } from '../../stores/modStore.js';
  import { initDownloadManager } from '../../utils/mods/modDownloadManager.js';
  import DownloadProgress from '../mods/components/DownloadProgress.svelte';
  import ModDependencyModal from '../mods/components/ModDependencyModal.svelte';
  import ClientModList from './ClientModList.svelte';
  import ClientManualModList from './ClientManualModList.svelte';
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
    installedModsInfo,
    modSyncStatus,
    isLoadingMods,
    lastModCheck,
    acknowledgedDeps
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
  }

  // State and helpers moved to dedicated store
  // Props
  export let instance: Instance | null = null; // Client instance
  export let clientModVersionUpdates = null; // Client mod version updates from server
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

  let isCheckingModSync = false; // Guard to prevent reactive loops
  let manualModsRefreshTrigger: number = 0; // Trigger to refresh manual mods list
  
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
    if (!$modSyncStatus?.acknowledgments) return [];    const filtered = $modSyncStatus.acknowledgments.filter(ack =>
      !$acknowledgedDeps.has(ack.fileName.toLowerCase())
    );
    
    return filtered;
  })();



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
    }
  }

  // Connect to server and get mod information
  onMount(() => {
    downloadManagerCleanup = initDownloadManager();
    if (instance?.path) {
      // Populate local mod status even if not connected to a server
      refreshInstalledMods(instance);
      
      // Load acknowledged dependencies from persistent storage
      loadAcknowledgedDependencies();
    }
    unsubscribeInstalledInfo = installedModInfo.subscribe(() => {
      // Only check mod synchronization if we're not already in the middle of checking
      // This prevents reactive loops that could cause the spam of log messages
      if (!isCheckingModSync) {
        checkModSynchronization(instance);
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
        await loadModsFromServer(instance);
        await checkModSynchronization(instance); // This will properly detect removal needs
      })();
        
      // Set up periodic mod checking - reduced frequency to prevent flashing
      const interval = setInterval(() => loadModsFromServer(instance), 5 * 60 * 1000); // Check every 5 minutes instead of 30 seconds
      
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
    refreshInstalledMods(instance);
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

            await refreshInstalledMods(instance);
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

          await refreshInstalledMods(instance);
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
      refreshInstalledMods(instance);
    }
    if (tab === 'find-mods') {
      // Refresh installed mod info when switching to find-mods tab
        loadInstalledInfo(instance);
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
    await loadInstalledInfo(instance);
    
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
  <div class="page-header">
    <h2>Client Mods</h2>
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

  <!-- Compact Status Header -->
  {#if activeTab === 'installed-mods'}
    <div class="compact-status">
      <div class="status-line">
        {#if $connectionStatus === 'connected'}
          <span class="status-item connected">🔗 Connected</span>
        {:else}
          <span class="status-item disconnected">❌ Disconnected</span>
        {/if}
        
        {#if $lastModCheck}
          <span class="status-item">Last sync: {$lastModCheck.toLocaleTimeString()}</span>
        {/if}
        
        {#if $modSyncStatus}
          <span class="status-item">Required: {$modSyncStatus.synchronized && (!$modSyncStatus.needsAcknowledgment || $modSyncStatus.needsAcknowledgment === 0) ? '✅' : '⚠️'} {$requiredMods.length}/{$modSyncStatus.totalRequired || $requiredMods.length}</span>
          <span class="status-item">Optional: {$modSyncStatus.needsOptionalDownload && $modSyncStatus.needsOptionalDownload > 0 ? '⚠️' : '✅'} {displayOptionalMods.length - ($modSyncStatus.needsOptionalDownload || 0)}/{displayOptionalMods.length}</span>
        {/if}
      </div>
      
      <div class="status-actions">
        <button class="compact-btn" on:click={refreshMods} disabled={$isLoadingMods}>
          {$isLoadingMods ? '⏳' : '🔄'} Refresh
        </button>
        
        {#if $modSyncStatus && !$modSyncStatus.synchronized}
          {#if $modSyncStatus.needsDownload > 0}
            <button class="compact-btn primary" on:click={() => downloadRequiredMods(instance)}>
              📥 Download Required ({$modSyncStatus.needsDownload})
            </button>
          {:else}
            {@const actualRemovals = [...($modSyncStatus.requiredRemovals || []), ...($modSyncStatus.optionalRemovals || [])]}
            {@const acknowledgments = pendingAcknowledgments || []}
            
            {#if actualRemovals.length > 0}
              <button class="compact-btn primary" on:click={() => downloadRequiredMods(instance)}>
                🔄 Remove {actualRemovals.length} mod{actualRemovals.length > 1 ? 's' : ''}
              </button>
            {:else if acknowledgments.length > 0}
              <button class="compact-btn primary" on:click={() => acknowledgeAllDependencies(instance)}>
                ✓ Acknowledge ({acknowledgments.length})
              </button>
            {/if}
          {/if}
        {/if}
      </div>
    </div>
  {/if}

  <div class="mod-content">
    {#if activeTab === 'installed-mods'}
      <!-- Original server mod synchronization content -->
      {#if $connectionStatus === 'disconnected'}
        <div class="connection-error">
          <h3>⚠️ Cannot Connect to Server</h3>
          <p>Make sure the management server is running and accessible.</p>
            <button class="retry-button" on:click={() => loadModsFromServer(instance)}>
              🔄 Retry Connection
            </button>
        </div>
      {:else if $isLoadingMods && !$serverMods.length}
        <div class="loading">
          <h3>🔄 Loading Mods...</h3>
          <p>Fetching mod information from server...</p>
        </div>
      {:else}


        <!-- Mod Lists -->
        <div class="mod-sections">
          <!-- Required Mods Section -->
          <div class="mod-section">
            <ClientModList
              mods={displayRequiredMods}
              type="required"
              modSyncStatus={$modSyncStatus}
              serverManagedFiles={$serverManagedFiles}
              on:download={() => downloadRequiredMods(instance)}
              on:remove={(e) => handleServerModRemoval(instance, e.detail.fileName)}
              on:acknowledge={(e) => handleDependencyAcknowledgment(instance, e.detail.fileName)}
              on:updateMod={(e) => updateServerMod(instance, e)}
            />
          </div>

          <!-- Optional Mods Section -->
          {#if displayOptionalMods.length > 0}
            <div class="mod-section">
              <ClientModList
                mods={displayOptionalMods}
                type="optional"
                modSyncStatus={$modSyncStatus}
                serverManagedFiles={$serverManagedFiles}
                on:toggle={(e) => handleModToggle(instance, e.detail.fileName, e.detail.enabled)}
                on:download={() => downloadOptionalMods(instance)}
                on:downloadSingle={(e) => downloadSingleOptionalMod(instance, e.detail.mod)}
                on:delete={(e) => handleModDelete(instance, e.detail.fileName)}
                on:updateMod={(e) => updateServerMod(instance, e)}
              />
            </div>
          {/if}

          <!-- Client Downloaded Mods Section -->
          <div class="mod-section">
            {#if $errorMessage}
              <p class="error-message">
                {$errorMessage} Ensure your client path contains a <code>mods</code> directory.
              </p>
            {/if}
            <ClientManualModList
              clientPath={instance?.path || ''}
              refreshTrigger={manualModsRefreshTrigger}
              modSyncStatus={$modSyncStatus}
              {clientModVersionUpdates}
              on:toggle={(e) => handleModToggle(instance, e.detail.fileName, e.detail.enabled)}
              on:delete={(e) => handleModDelete(instance, e.detail.fileName)}
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

  .page-header {
    margin-bottom: 1.5rem;
  }

  .page-header h2 {
    color: white;
    margin: 0;
    font-size: 1.5rem;
  }

  /* Compact status header */
  .compact-status {
    display: flex;
    justify-content: space-between;
    align-items: center;
    padding: 0.75rem;
    background-color: #1f2937;
    border-radius: 6px;
    border: 1px solid #374151;
    margin-bottom: 1.5rem;
    gap: 1rem;
    flex-wrap: wrap;
  }

  .status-line {
    display: flex;
    gap: 1rem;
    align-items: center;
    flex-wrap: wrap;
  }

  .status-item {
    font-size: 0.85rem;
    color: #d1d5db;
    white-space: nowrap;
  }

  .status-item.connected {
    color: #10b981;
  }

  .status-item.disconnected {
    color: #ef4444;
  }

  .status-actions {
    display: flex;
    gap: 0.5rem;
    align-items: center;
  }

  .compact-btn {
    padding: 0.4rem 0.75rem;
    border: none;
    border-radius: 4px;
    font-size: 0.8rem;
    font-weight: 500;
    cursor: pointer;
    transition: background-color 0.2s;
    white-space: nowrap;
  }

  .compact-btn {
    background-color: #374151;
    color: white;
  }

  .compact-btn:hover:not(:disabled) {
    background-color: #4b5563;
  }

  .compact-btn:disabled {
    opacity: 0.5;
    cursor: not-allowed;
  }

  .compact-btn.primary {
    background-color: #3b82f6;
    color: white;
  }

  .compact-btn.primary:hover {
    background-color: #2563eb;
  }


  .retry-button {
    padding: 0.5rem 1rem;
    border: none;
    border-radius: 6px;
    font-weight: 500;
    cursor: pointer;
    transition: background-color 0.2s;
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

  .mod-sections {
    display: flex;
    flex-direction: column;
    gap: 1.5rem;
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
