<script lang="ts">
  import { onMount, onDestroy } from 'svelte';
  import { createEventDispatcher } from 'svelte';
  import { get } from 'svelte/store';
  import { 
    errorMessage, 
    successMessage,
    searchKeyword,
    modSource,
    searchResults,
    isSearching,
    searchError,
    currentPage,
    totalPages,
    totalResults,
    resultsPerPage,
    expandedModId,
    minecraftVersion,
    loaderType,
    installingModIds,
    filterMinecraftVersion,
    filterModLoader,
    serverManagedFiles
  } from '../../stores/modStore.js';
  import { searchMods, fetchModVersions } from '../../utils/mods/modAPI.js';
  import { installedModIds, installedModInfo } from '../../stores/modStore.js';
  import { initDownloadManager } from '../../utils/mods/modDownloadManager.js';
  import DownloadProgress from '../mods/components/DownloadProgress.svelte';
  import ClientModList from './ClientModList.svelte';
  import ClientManualModList from './ClientManualModList.svelte';
  import ClientModStatus from './ClientModStatus.svelte';
  import ModCard from '../mods/components/ModCard.svelte';
  import ModSearch from '../mods/components/ModSearch.svelte';
  import ModDropZone from '../mods/components/ModDropZone.svelte';
  import { uploadDroppedMods } from '../../utils/directFileUpload.js';

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
  }

  interface ModSyncStatus {
    synchronized: boolean;
    needsDownload?: number;
    needsOptionalDownload?: number;
    totalRequired?: number;
    totalOptional?: number;
    totalPresent?: number;
    totalOptionalPresent?: number;
    missingMods?: string[];
    missingOptionalMods?: string[];
    presentEnabledMods?: string[];
    presentDisabledMods?: string[];
  }

  // Props
  export let instance: Instance | null = null; // Client instance

  // Create event dispatcher
  const dispatch = createEventDispatcher();
  // State
  let connectionStatus: string = 'disconnected';
  let serverMods: ClientMod[] = [];
  let clientMods: ClientMod[] = [];
  let requiredMods: ClientMod[] = [];
  let optionalMods: ClientMod[] = [];
  let allClientMods: ClientMod[] = []; // All client mods (required + optional)
  let modSyncStatus: ModSyncStatus | null = null;
  let isLoadingMods: boolean = false;
  let lastModCheck: Date | null = null;
  
  // Client mod finding state
  let activeTab: string = 'installed-mods'; // 'installed-mods' or 'find-mods'
  let versionsCache = {};
  let versionsLoading = {};
  let versionsError = {};
  let minecraftVersionOptions = [get(minecraftVersion) || '1.20.1'];
  let manualMods: ClientMod[] = [];
  let filterType = 'client';
  let downloadManagerCleanup;
  let unsubscribeInstalledInfo;
  let previousPath: string | null = null;

  // Connect to server and get mod information
  onMount(() => {
    downloadManagerCleanup = initDownloadManager();
    if (instance?.path) {
      // Populate local mod status even if not connected to a server
      refreshInstalledMods();
    }
    unsubscribeInstalledInfo = installedModInfo.subscribe(() => {
      checkModSynchronization();
    });
    // Initialize filter stores for client mod search
    if (!get(filterMinecraftVersion)) {
      filterMinecraftVersion.set(get(minecraftVersion) || '1.20.1');
    }
    if (!get(filterModLoader)) {
      filterModLoader.set(get(loaderType) || 'fabric');
    }
    
    if (instance && instance.serverIp && instance.serverPort) {
      loadModsFromServer();
      
      // Set up periodic mod checking
      const interval = setInterval(loadModsFromServer, 30000); // Check every 30 seconds
      
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
    }
  }
  // Update manual mods based on current synchronization status
  function updateManualMods() {
    const info = get(installedModInfo);
    
    if (!info || info.length === 0) {
      manualMods = [];
      return;
    }
    // Also include server-only mods in the 'managed' set so they don't appear as manual client mods
    const managed = new Set([
      ...requiredMods.map(m => m.fileName.toLowerCase()),
      ...optionalMods.map(m => m.fileName.toLowerCase()),
      ...serverMods.map(m => m.fileName.toLowerCase()) // Include server-only mods
    ]);

    const disabledSet = new Set(
      (modSyncStatus?.presentDisabledMods || []).map(f => f.toLowerCase())
    );

    const filteredMods = info.filter(mod => !managed.has(mod.fileName.toLowerCase()));

    manualMods = filteredMods.map(mod => ({
        fileName: mod.fileName,
        location: disabledSet.has(mod.fileName.toLowerCase()) ? 'disabled' : 'client',
        projectId: mod.projectId,
        versionId: mod.versionId,
        versionNumber: mod.versionNumber,
        name: mod.name
      }));
  }  async function loadInstalledInfo() {
    try {
      const info = await window.electron.invoke('get-client-installed-mod-info', instance.path);
      if (Array.isArray(info)) {
        installedModIds.set(new Set(info.map(i => i.projectId).filter(Boolean)));
        installedModInfo.set(info);
        
        // Force update manual mods after setting the store
        setTimeout(() => {
          updateManualMods();
        }, 100);
      } else {
        console.warn('Received non-array mod info:', info);
      }
    } catch (err) {
      console.error('Failed to load installed mod info:', err);
    }
  }  // Load mods from the management server
  async function loadModsFromServer() {
    if (!instance || !instance.serverIp || !instance.serverPort) {
      serverManagedFiles.set(new Set());
      return;
    }

    isLoadingMods = true;
    
    try {
      // Check connection to management server
      const testUrl = `http://${instance.serverIp}:${instance.serverPort}/api/test`;
      const testResponse = await fetch(testUrl, {
        method: 'GET',
        signal: AbortSignal.timeout(5000)
      });

      if (!testResponse.ok) {
        console.log('[ClientModManager] Server connection failed');
        connectionStatus = 'disconnected';
        serverManagedFiles.set(new Set());
        return;
      }

      connectionStatus = 'connected';
      console.log('[ClientModManager] Connected to server successfully');

      // Get server info which includes required mods
      const serverInfoUrl = `http://${instance.serverIp}:${instance.serverPort}/api/server/info`;
      const serverInfoResponse = await fetch(serverInfoUrl, {
        method: 'GET',
        signal: AbortSignal.timeout(5000)
      });

      if (serverInfoResponse.ok) {
        const serverInfo = await serverInfoResponse.json();
        console.log('[ClientModManager] Received server info:', serverInfo);
        if (serverInfo.success) {
          if (serverInfo.minecraftVersion) {
            minecraftVersion.set(serverInfo.minecraftVersion);
          }
          requiredMods = serverInfo.requiredMods || [];
          allClientMods = serverInfo.allClientMods || [];
          console.log('[ClientModManager] Set requiredMods:', requiredMods);
          console.log('[ClientModManager] Set allClientMods:', allClientMods);

          // Update global store with server-managed mod file names
          const managed = new Set([
            ...requiredMods.map(m => m.fileName),
            ...(allClientMods || []).map(m => m.fileName)
          ]);
          serverManagedFiles.set(managed);
          console.log('[ClientModManager] Set server managed files:', Array.from(managed));
          
          // Get full mod list from server
          const modsUrl = `http://${instance.serverIp}:${instance.serverPort}/api/mods/list`;
          const modsResponse = await fetch(modsUrl, {
            method: 'GET',
            signal: AbortSignal.timeout(5000)
          });

          if (modsResponse.ok) {
            const modsData = await modsResponse.json();
            console.log('[ClientModManager] Received mods data:', modsData);
            if (modsData.success) {
              serverMods = modsData.mods.server || [];
              const bothMods = modsData.mods.both || [];
              const clientOnlyMods = modsData.mods.client || [];
              
              // Combine client and both mods for client mod list
              clientMods = [...clientOnlyMods, ...bothMods];
              
              // Separate required and optional mods based on server configuration
              // Required mods are those specified by the server
              optionalMods = clientMods.filter(mod => 
                !requiredMods.some(reqMod => reqMod.fileName === mod.fileName)
              );
            }
          }

          // Check mod synchronization status if we have a client path
          if (instance.path) {
            await checkModSynchronization();
          }
        }
      }

      lastModCheck = new Date();
    } catch (err) {
      console.error('[ClientModManager] Error loading mods from server:', err);
      connectionStatus = 'disconnected';
      serverManagedFiles.set(new Set());
      errorMessage.set('Failed to connect to server: ' + err.message);
      setTimeout(() => errorMessage.set(''), 5000);
    } finally {
      isLoadingMods = false;
      updateManualMods();
    }
  }

  // Check mod synchronization status
  async function checkModSynchronization() {
    if (!instance?.path) {
      return;
    }

    try {
      const result = await window.electron.invoke('minecraft-check-mods', {
        clientPath: instance.path,
        requiredMods,
        allClientMods
      });

      if (result.success) {
        modSyncStatus = result;

        // Emit event to parent about sync status
        dispatch('mod-sync-status', {
          synchronized: result.synchronized,
          needsDownload: result.needsDownload,
          totalRequired: result.totalRequired,
          totalPresent: result.totalPresent
        });
      } else {
        errorMessage.set(
          `${result.error || 'Failed to check mod synchronization.'}`
        );
        setTimeout(() => errorMessage.set(''), 5000);
      }
    } catch (err) {
      console.error('[ClientModManager] Error checking mod synchronization:', err);
      errorMessage.set('Failed to check mod synchronization.');
      setTimeout(() => errorMessage.set(''), 5000);
    }
    updateManualMods();
  }

  // Reload installed mod info and update synchronization status
  async function refreshInstalledMods() {
    if (!instance?.path) return;
    await loadInstalledInfo();
    await checkModSynchronization();
    updateManualMods();
  }

  // Download required mods
  async function downloadRequiredMods() {
    if (!instance.path || !requiredMods.length) {
      return;
    }

    try {
      const result = await window.electron.invoke('minecraft-download-mods', {
        clientPath: instance.path,
        requiredMods,
        allClientMods,
        serverInfo: {
          serverIp: instance.serverIp,
          serverPort: instance.serverPort
        }
      });

      if (result.success) {
        successMessage.set(`Successfully downloaded ${result.downloaded} required mods`);
        setTimeout(() => successMessage.set(''), 5000);
        
        // Refresh mod sync status
        await checkModSynchronization();
      } else {
        errorMessage.set(`Failed to download mods: ${result.error || 'Unknown error'}`);
        setTimeout(() => errorMessage.set(''), 5000);
      }
    } catch (err) {
      console.error('[ClientModManager] Error downloading mods:', err);
      errorMessage.set('Error downloading mods: ' + err.message);
      setTimeout(() => errorMessage.set(''), 5000);
    }
  }

  // Download optional mods
  async function downloadOptionalMods() {
    if (!instance.path || !allClientMods.length) {
      return;
    }

    // Get only the optional mods that are missing
    const optionalMods = allClientMods.filter(mod => !mod.required);
    
    if (!optionalMods.length) {
      return;
    }

    try {
      const result = await window.electron.invoke('minecraft-download-mods', {
        clientPath: instance.path,
        requiredMods: optionalMods, // Use the same parameter name for consistency
        allClientMods,
        serverInfo: {
          serverIp: instance.serverIp,
          serverPort: instance.serverPort
        }
      });

      if (result.success) {
        successMessage.set(`Successfully downloaded ${result.downloaded} optional mods`);
        setTimeout(() => successMessage.set(''), 5000);
        
        // Refresh mod sync status
        await checkModSynchronization();
      } else {
        errorMessage.set(`Failed to download optional mods: ${result.error || 'Unknown error'}`);
        setTimeout(() => errorMessage.set(''), 5000);
      }
    } catch (err) {
      console.error('[ClientModManager] Error downloading optional mods:', err);
      errorMessage.set('Error downloading optional mods: ' + err.message);
      setTimeout(() => errorMessage.set(''), 5000);
    }
  }

  // Refresh mods from server
  async function refreshMods() {
    await loadModsFromServer();
    await refreshInstalledMods();
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
    }
  }

  // Handle mod enable/disable for optional mods
  async function handleModToggle(modFileName, enabled) {
    if (!instance.path) return;

    try {
      // For now, we'll just handle this locally
      // In the future, this could sync with server preferences
      const result = await window.electron.invoke('toggle-client-mod', {
        clientPath: instance.path,
        modFileName,
        enabled
      });

      if (result.success) {
        successMessage.set(`Mod ${enabled ? 'enabled' : 'disabled'}: ${modFileName}`);
        setTimeout(() => successMessage.set(''), 3000);
        
        // Refresh mod status
        await checkModSynchronization();
      } else {
        errorMessage.set(`Failed to ${enabled ? 'enable' : 'disable'} mod: ${result.error}`);
        setTimeout(() => errorMessage.set(''), 5000);
      }
    } catch (err) {
      console.error('[ClientModManager] Error toggling mod:', err);
      errorMessage.set('Error toggling mod: ' + err.message);
      setTimeout(() => errorMessage.set(''), 5000);
    }
  }

  // Delete a mod from the client
  async function handleModDelete(modFileName) {
    if (!instance.path) return;

    try {
      const result = await window.electron.invoke('delete-client-mod', {
        clientPath: instance.path,
        modFileName
      });

      if (result.success) {
        successMessage.set(`Deleted mod: ${modFileName}`);
        setTimeout(() => successMessage.set(''), 3000);
        installedModInfo.update(info => {
          const updated = info.filter(m => m.fileName !== modFileName);
          const removed = info.find(m => m.fileName === modFileName);
          if (removed && removed.projectId) {
            installedModIds.update(ids => {
              ids.delete(removed.projectId);
              return new Set(ids);
            });
          }
          return updated;
        });
        await refreshInstalledMods();
      } else {
        errorMessage.set(`Failed to delete mod: ${result.error}`);
        setTimeout(() => errorMessage.set(''), 5000);
      }
    } catch (err) {
      console.error('[ClientModManager] Error deleting mod:', err);
      errorMessage.set('Error deleting mod: ' + err.message);
      setTimeout(() => errorMessage.set(''), 5000);
    }
  }

  
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
  async function installClientMod(mod, versionId = null) {
    if (!instance.path) {
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
        clientPath: instance.path,
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
      console.error('[ClientModManager] Error installing mod:', err);
      errorMessage.set(`Failed to install ${mod.name}: ${err.message}`);
      setTimeout(() => errorMessage.set(''), 5000);
    } finally {
      installingModIds.update(ids => {
        ids.delete(mod.id);
        return ids;
      });
    }
  }

  // Update an already installed mod to a specific version
  async function updateInstalledMod(modName, projectId, versionId) {
    if (!projectId || !versionId) return;

    const baseName = modName.replace(/\.jar$/i, '');
    const mod = {
      id: projectId,
      name: baseName,
      title: baseName,
      forceReinstall: true
    };

    await installClientMod(mod, versionId);
  }

  function switchTab(tab) {
    activeTab = tab;
    if (tab === 'installed-mods') {
      refreshInstalledMods();
    }
    if (tab === 'find-mods' && get(searchResults).length === 0 && get(searchKeyword)) {
      searchClientMods();
    }
  }

  // Load versions for a mod
  async function loadVersions(event) {
    const { modId, loadAll = false } = event.detail;
    
    if (versionsLoading[modId]) return;
    
    versionsLoading[modId] = true;
    versionsError[modId] = null;
    
    try {
      const versions = await fetchModVersions(modId, get(modSource), !loadAll, loadAll);
      versionsCache[modId] = versions;
    } catch (error) {
      console.error('Failed to load versions:', error);
      versionsError[modId] = error.message;
    } finally {
      versionsLoading[modId] = false;
    }
  }

  // Handle version selection
  function handleVersionSelect(event) {
    const { mod, versionId } = event.detail;
    // Store the selected version for later installation
    mod.selectedVersionId = versionId;
  }
  // Handle mod installation
  async function handleInstallMod(event) {
    const { mod, versionId } = event.detail;
    const ver = versionId || mod.selectedVersionId;
    
    // Handle manual mod version changes
    if (mod.fileName && mod.projectId && !mod.id) {
      // This is a manual mod version change - create proper mod object
      const modForInstall = {
        id: mod.projectId,
        name: mod.name || mod.fileName.replace(/\.jar$/i, ''),
        title: mod.name || mod.fileName.replace(/\.jar$/i, ''),
        forceReinstall: true
      };
      await installClientMod(modForInstall, ver);
    } else {
      // Regular mod installation from search
      await installClientMod(mod, ver);
    }
  }

  // Handle pagination
  async function handlePageChange(page) {
    currentPage.set(page);
    await searchClientMods();
  }

  // Navigate to previous page
  function prevPage() {
    if (get(currentPage) > 1) {
      handlePageChange(get(currentPage) - 1);
    }
  }

  // Navigate to next page
  function nextPage() {
    if (get(currentPage) < get(totalPages)) {
      handlePageChange(get(currentPage) + 1);
    }
  }
</script>

<div class="client-mod-manager">
  <DownloadProgress />
  <div class="mod-manager-header">
    <h2>Client Mods</h2>
    <div class="connection-status">
      {#if connectionStatus === 'connected'}
        <span class="status connected">✅ Connected to Server</span>
      {:else}
        <span class="status disconnected">❌ Disconnected from Server</span>
      {/if}
      {#if lastModCheck}
        <span class="last-check">Last updated: {lastModCheck.toLocaleTimeString()}</span>
      {/if}
    </div>
    <div class="mod-actions">
      <button class="refresh-button" on:click={refreshMods} disabled={isLoadingMods}>
        {isLoadingMods ? '⏳ Loading...' : '🔄 Refresh'}
      </button>
      {#if modSyncStatus && !modSyncStatus.synchronized}
        <button class="download-button" on:click={downloadRequiredMods}>
          📥 Download Required Mods ({modSyncStatus.needsDownload})
        </button>
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
      {#if connectionStatus === 'disconnected'}
        <div class="connection-error">
          <h3>⚠️ Cannot Connect to Server</h3>
          <p>Make sure the management server is running and accessible.</p>
          <button class="retry-button" on:click={loadModsFromServer}>
            🔄 Retry Connection
          </button>
        </div>
      {:else if isLoadingMods && !serverMods.length}
        <div class="loading">
          <h3>🔄 Loading Mods...</h3>
          <p>Fetching mod information from server...</p>
        </div>
      {:else}
        <!-- Mod Status Overview -->
        <ClientModStatus
          {modSyncStatus}
          requiredModsCount={requiredMods.length}
          optionalModsCount={optionalMods.length}
          on:download-required={downloadRequiredMods}
          on:download-optional={downloadOptionalMods}
          on:refresh={refreshMods}
        />        <!-- ModDropZone -->
        <ModDropZone on:filesDropped={handleDroppedFiles} />

        <!-- Mod Lists -->
        <div class="mod-sections">
          <!-- Required Mods Section -->
          <div class="mod-section">
            <h3>Required Mods</h3>
            <p class="section-description">
              These mods are required by the server and cannot be disabled.
            </p>
          <ClientModList
            mods={requiredMods}
            type="required"
            {modSyncStatus}
            on:download={downloadRequiredMods}
            on:updateMod={(e) => updateInstalledMod(e.detail.modName, e.detail.projectId, e.detail.versionId)}
          />
          </div>

          <!-- Optional Mods Section -->
          {#if optionalMods.length > 0}
            <div class="mod-section">
              <h3>Optional Mods</h3>
              <p class="section-description">
                These mods are available but not required. You can enable or disable them before playing.
              </p>
          <ClientModList
            mods={optionalMods}
            type="optional"
            {modSyncStatus}
            on:toggle={(e) => handleModToggle(e.detail.fileName, e.detail.enabled)}
            on:download={downloadRequiredMods}
            on:delete={(e) => handleModDelete(e.detail.fileName)}
            on:updateMod={(e) => updateInstalledMod(e.detail.modName, e.detail.projectId, e.detail.versionId)}
          />
        </div>
      {/if}          <!-- Client-Side Mods Section -->
          <div class="mod-section">
            <h3>Client-Side Mods</h3>
          <p class="section-description">
            Mods installed by you (not synced from server).
          </p>
          {#if $errorMessage}            <p class="error-message">
              {$errorMessage} Ensure your client path contains a <code>mods</code> directory.
            </p>
          {/if}          <ClientManualModList
            clientPath={instance?.path || ''}
            mods={manualMods}
            on:toggle={(e) => handleModToggle(e.detail.fileName, e.detail.enabled)}
            on:delete={(e) => handleModDelete(e.detail.fileName)}
            on:install={handleInstallMod}            />
          </div>
        </div>
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
