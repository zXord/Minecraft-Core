<script>
  import { onMount, onDestroy, createEventDispatcher } from 'svelte';
  
  import { SvelteSet } from 'svelte/reactivity';import { get } from 'svelte/store';
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
  import { searchContent, loadContent } from '../../utils/mods/modAPI.js';
  import { installedModIds, installedModInfo, installedShaders, installedResourcePacks, installedShaderIds, installedResourcePackIds, installedShaderInfo, installedResourcePackInfo } from '../../stores/modStore.js';
  import { initDownloadManager } from '../../utils/mods/modDownloadManager.js';
  import DownloadProgress from '../mods/components/DownloadProgress.svelte';
  import ModDependencyModal from '../mods/components/ModDependencyModal.svelte';
  import ClientModList from './ClientModList.svelte';
  import ClientManualModList from './ClientManualModList.svelte';
  import ClientAssetList from './ClientAssetList.svelte';
  import ModSearch from '../mods/components/ModSearch.svelte';
  import ModDropZone from '../mods/components/ModDropZone.svelte';
  import ConfirmationDialog from '../common/ConfirmationDialog.svelte';
  import { uploadDroppedMods } from '../../utils/directFileUpload.js';
  import { checkModDependencies, showDependencyModal, installWithDependencies } from '../../utils/mods/modDependencyHelper.js';
  import { checkDependencyCompatibility } from '../../utils/mods/modCompatibility.js';
  import { safeInvoke } from '../../utils/ipcUtils.js';
  import { buildAuthHeaders, ensureSessionToken, getManagementBaseUrl } from '../../utils/managementAuth.js';
  // Content-type aware stores for shaders/resource packs search and tabs
  import {
    activeContentType,
    CONTENT_TYPES,
  shaderResults,
  resourcePackResults,
  contentTypeConfigs,
  contentTypeSwitching
  } from '../../stores/modStore.js';
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
    downloadSingleRequiredMod,
    handleModToggle,
    handleModDelete,
    handleServerModRemoval,
    handleBulkServerModRemoval,
    handleDependencyAcknowledgment,
    updateServerMod
  } from '../../utils/clientMods.js';

  // Types

  // State and helpers moved to dedicated store
  // Props
  /** @type {null | {path: string, serverIp?: string, serverPort?: string, serverProtocol?: string, sessionToken?: string, name?: string}} */
  export let instance = null; // Client instance
  /** @type {null | any} */
  export let clientModVersionUpdates = null; // Client mod version updates from server
  
  // Event dispatcher
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
  let activeTab = 'installed';
  let manualModsRefreshTrigger = 0;
  // Client assets (shaders/resource packs)
  let shaderAssets = [];
  let resourcePackAssets = [];
  // Server-provided required assets
  let serverShaderItems = [];
  let serverResourcePackItems = [];

  // Derived lists for asset rendering
  $: serverShaderSet = new Set((serverShaderItems || []).map(it => (it.fileName || '').toLowerCase().split(/[\\\/]/).pop()));
  $: requiredShaderItemsExtended = [
    ...serverShaderItems.map(it => ({ ...it })),
    ...shaderAssets
      .filter(a => a && a.source === 'server' && !serverShaderSet.has((a.fileName || '').toLowerCase().split(/[\\\/]/).pop()))
      .map(a => ({ fileName: a.fileName, needsRemoval: true }))
  ];
  $: extraShaders = (shaderAssets || []).filter(a => a && !serverShaderSet.has((a.fileName || '').toLowerCase().split(/[\\\/]/).pop()) && a.source !== 'server');

  $: serverRpSet = new Set((serverResourcePackItems || []).map(it => (it.fileName || '').toLowerCase().split(/[\\\/]/).pop()));
  $: requiredResourcePackItemsExtended = [
    ...serverResourcePackItems.map(it => ({ ...it })),
    ...resourcePackAssets
      .filter(a => a && a.source === 'server' && !serverRpSet.has((a.fileName || '').toLowerCase().split(/[\\\/]/).pop()))
      .map(a => ({ fileName: a.fileName, needsRemoval: true }))
  ];
  $: extraRps = (resourcePackAssets || []).filter(a => a && !serverRpSet.has((a.fileName || '').toLowerCase().split(/[\\\/]/).pop()) && a.source !== 'server');

  // Notify other parts of the app (Play tab) when assets change
  function notifyAssetsChanged() {
    try {
      window.dispatchEvent(new CustomEvent('assets-changed'));
    } catch {}
  }

  // Component references
  let optionalModListComponent;
  let clientManualModListComponent;

  let downloadManagerCleanup;
  let unsubscribeInstalledInfo;
  let previousPath= null;
  // Local delete confirmation state for asset deletions
  let showAssetDeleteConfirm = false;
  let pendingAssetDelete = null; // { type: 'shaderpacks'|'resourcepacks', fileName: string }

  let isCheckingModSync = false; // Guard to prevent reactive loops
  
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
          const newSet = new SvelteSet(currentSet);
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
    // Initialize filter stores for client mod search (only if null/undefined, not empty string)
    const currentFilterVer = get(filterMinecraftVersion);
    if (currentFilterVer === null || currentFilterVer === undefined) {
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
  refreshAssets();
  }



  // Reload installed mod info and update synchronization status
  async function refreshMods() {
    await loadModsFromServer(instance);
    await refreshInstalledMods(instance);
    await refreshAssets();
    successMessage.set('Mod list refreshed');
    setTimeout(() => successMessage.set(''), 3000);
  }

  async function refreshAssets() {
    if (!instance?.path) return;
    try {
      const shaderRes = await window.electron.invoke('list-client-assets', { clientPath: instance.path, type: 'shaderpacks' });
      shaderAssets = shaderRes?.success ? (shaderRes.items || []) : [];
      const rpRes = await window.electron.invoke('list-client-assets', { clientPath: instance.path, type: 'resourcepacks' });
      resourcePackAssets = rpRes?.success ? (rpRes.items || []) : [];

      // Log inputs for diagnosis: server vs installed asset metadata
      try {
        console.debug('[ClientModManager] assets refresh snapshot', {
          shaders: {
            server: serverShaderItems.map(x => ({ f: x.fileName, v: x.versionNumber || null, c: (x.checksum||'').slice(0,8) })),
            installed: shaderAssets.map(x => ({ f: x.fileName, v: x.versionNumber || null, c: (x.checksum||'').slice(0,8) }))
          },
          resourcepacks: {
            server: serverResourcePackItems.map(x => ({ f: x.fileName, v: x.versionNumber || null, c: (x.checksum||'').slice(0,8) })),
            installed: resourcePackAssets.map(x => ({ f: x.fileName, v: x.versionNumber || null, c: (x.checksum||'').slice(0,8) }))
          }
        });
      } catch {}

      // Also fetch server-required items for assets to compute Required status
      if (instance?.serverIp && instance?.serverPort) {
        try {
          await ensureSessionToken(instance);
          const base = getManagementBaseUrl(instance);
          if (!base) return;
          const [srvShaders, srvRps] = await Promise.all([
            fetch(`${base}/api/assets/list/shaderpacks`, {
              method: 'GET',
              headers: buildAuthHeaders(instance),
              signal: AbortSignal.timeout(10000)
            }).then(r => r.ok ? r.json() : null).catch(() => null),
            fetch(`${base}/api/assets/list/resourcepacks`, {
              method: 'GET',
              headers: buildAuthHeaders(instance),
              signal: AbortSignal.timeout(10000)
            }).then(r => r.ok ? r.json() : null).catch(() => null)
          ]);
          serverShaderItems = srvShaders?.success ? (srvShaders.items || []) : [];
          serverResourcePackItems = srvRps?.success ? (srvRps.items || []) : [];
          // Log server required lists as part of snapshot
        } catch {
          // ignore server list fetch errors
        }
      }
      // Update global stores so Search/Mod cards can reflect installed status immediately
      try {

        // Shaders
        const shaderFileNames = (shaderAssets || []).map(a => a.fileName).filter(Boolean);
        const shaderIdsSet = new Set((shaderAssets || []).map(a => a.projectId).filter(Boolean));
        const shaderInfoList = (shaderAssets || []).map(a => ({
          fileName: a.fileName,
          projectId: a.projectId || null,
          versionId: a.versionId || null,
          versionNumber: a.versionNumber || null,
          name: a.name || (a.fileName ? a.fileName.replace(/\.(zip|jar)$/i, '') : null),
          source: a.source || 'modrinth'
        }));
        installedShaders.set(shaderFileNames);
        installedShaderIds.set(shaderIdsSet);
        installedShaderInfo.set(shaderInfoList);

  // Resource Packs
        const rpFileNames = (resourcePackAssets || []).map(a => a.fileName).filter(Boolean);
        const rpIdsSet = new Set((resourcePackAssets || []).map(a => a.projectId).filter(Boolean));
        const rpInfoList = (resourcePackAssets || []).map(a => ({
          fileName: a.fileName,
          projectId: a.projectId || null,
          versionId: a.versionId || null,
          versionNumber: a.versionNumber || null,
          name: a.name || (a.fileName ? a.fileName.replace(/\.(zip|jar)$/i, '') : null),
          source: a.source || 'modrinth'
        }));
        installedResourcePacks.set(rpFileNames);
        installedResourcePackIds.set(rpIdsSet);
        installedResourcePackInfo.set(rpInfoList);
  // Reduced logging
      } catch (_) {}
    } catch (e) {
      // ignore UI errors
    } finally {
    }
  }

  // Debug: when server/installed shader lists change, map required -> installed version
  $: if (shaderAssets && serverShaderItems) {
    try {
      const installedByName = new Map(shaderAssets.map(a => [a.fileName.toLowerCase(), a]));
      const mapping = serverShaderItems.slice(0, 10).map(it => {
        const inst = installedByName.get((it.fileName || '').toLowerCase());
        return { fileName: it.fileName, installedVersion: inst?.versionNumber || null };
      });
      console.debug('[ClientModManager] required shaders → installed version mapping (sample)', mapping);
    } catch {}
  }

  $: if (resourcePackAssets && serverResourcePackItems) {
    try {
      const installedByName = new Map(resourcePackAssets.map(a => [a.fileName.toLowerCase(), a]));
      const mapping = serverResourcePackItems.slice(0, 10).map(it => {
        const inst = installedByName.get((it.fileName || '').toLowerCase());
        return { fileName: it.fileName, installedVersion: inst?.versionNumber || null };
      });
      console.debug('[ClientModManager] required resourcepacks → installed version mapping (sample)', mapping);
    } catch {}
  }

  // Handle installing a different version for a client asset (using Modrinth)
  async function handleInstallAssetVersion(event) {
    const { item, version } = event.detail;
    if (!item?.projectId || !version?.id) return;
    try {
      const modLike = {
        id: item.projectId,
        name: item.name || item.fileName.replace(/\.(zip|jar)$/i, ''),
        selectedVersionId: version.id,
        source: 'modrinth'
      };
      const modData = {
        ...modLike,
        loader: get(loaderType) || 'fabric',
        version: get(minecraftVersion) || '1.20.1',
        clientPath: instance?.path,
        forceReinstall: true,
        contentType: $activeContentType === CONTENT_TYPES.SHADERS ? 'shaders' : ($activeContentType === CONTENT_TYPES.RESOURCE_PACKS ? 'resourcepacks' : 'mods')
      };
      const result = await window.electron.invoke('install-client-mod', modData);
      if (result?.success) {
        await refreshAssets();
        notifyAssetsChanged();
        successMessage.set('Installed selected version');
        setTimeout(() => successMessage.set(''), 2500);
      }
    } catch (e) {
      errorMessage.set('Failed to install selected version');
      setTimeout(() => errorMessage.set(''), 3000);
    }
  }

  function countMissingAssets(requiredList, installedList) {
    if (!requiredList?.length) return 0;
  const baseName = (fn) => (fn || '').toLowerCase().split(/[\\\/]/).pop();
  const installedSet = new Set((installedList || []).map(a => baseName(a.fileName)));
  return requiredList.filter(it => !installedSet.has(baseName(it.fileName))).length;
  }

  function countOutdatedAssets(requiredList, installedList) {
    if (!requiredList?.length || !installedList?.length) return 0;
    const baseName = (fn) => (fn || '').toLowerCase().split(/[\\\/]/).pop();
    const installedMap = new Map((installedList || []).map(a => [baseName(a.fileName), a]));
    let updates = 0;
    for (const srv of (requiredList || [])) {
      const key = baseName(srv.fileName);
      const loc = installedMap.get(key);
      if (!loc) continue; // handled by missing
      const srvV = srv?.versionNumber || null;
      const locV = loc?.versionNumber || null;
      const srvC = srv?.checksum || null;
      const locC = loc?.checksum || null;
      if ((srvV && locV && srvV !== locV) || (srvV && !locV) || (srvC && locC && srvC !== locC)) {
        updates += 1;
      }
    }
    return updates;
  }

  async function downloadRequiredAssets(type) {
    if (!instance?.path || !instance?.serverIp || !instance?.serverPort) return;
    const requiredItems = type === 'shaderpacks' ? serverShaderItems : serverResourcePackItems;
    if (!requiredItems?.length) return;
    try {
  await window.electron.invoke('minecraft-download-assets', {
        clientPath: instance.path,
        type,
        requiredItems,
        serverInfo: { serverIp: instance.serverIp, serverPort: instance.serverPort, serverProtocol: instance.serverProtocol, sessionToken: instance.sessionToken }
      });
  await refreshAssets();
  notifyAssetsChanged();
      successMessage.set('Assets synchronized');
      setTimeout(() => successMessage.set(''), 3000);
    } catch (err) {
      // ignore; progress UI handles errors elsewhere
    }
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
      // Reset the relevant results store for current content type
      if ($activeContentType === CONTENT_TYPES.MODS) {
        searchResults.set([]);
      } else if ($activeContentType === CONTENT_TYPES.SHADERS) {
        shaderResults.set([]);
      } else if ($activeContentType === CONTENT_TYPES.RESOURCE_PACKS) {
        resourcePackResults.set([]);
      }
      return;
    }

    // Set environment type for client mods
    await searchContent($activeContentType || CONTENT_TYPES.MODS, {
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
        // loader is only relevant for mods; backend ignores for shaders/resourcepacks
        loader: get(loaderType) || 'fabric',
        version: get(minecraftVersion) || '1.20.1',
        clientPath: pathToUse,
        forceReinstall: isUpdate,
        contentType: $activeContentType || CONTENT_TYPES.MODS
      };

      const result = await window.electron.invoke('install-client-mod', modData);

      if (result && result.success) {
        successMessage.set(`Successfully installed ${mod.name} to client`);
        setTimeout(() => successMessage.set(''), 5000);
        // Refresh based on content type
        if ($activeContentType === CONTENT_TYPES.MODS) {
          installedModIds.update(ids => {
            ids.add(mod.id);
            return new SvelteSet(ids);
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
          // Silent refresh for shaders/resource packs so Installed shows immediately
          await refreshAssets();
          notifyAssetsChanged();
        }
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
    if (tab === 'installed') {
      if ($activeContentType === CONTENT_TYPES.MODS) {
        refreshInstalledMods(instance);
      } else {
        // Fetch assets so returning from Find shows latest without visible spinner
        refreshAssets();
      }
    }
    if (tab === 'search') {
      // Refresh installed mod info when switching to find-mods tab
        loadInstalledInfo(instance);
      // Trigger search if we have a keyword and current content type has no results yet
      const hasKeyword = !!get(searchKeyword);
      const hasResults =
        ($activeContentType === CONTENT_TYPES.MODS && get(searchResults).length > 0) ||
        ($activeContentType === CONTENT_TYPES.SHADERS && get(shaderResults).length > 0) ||
        ($activeContentType === CONTENT_TYPES.RESOURCE_PACKS && get(resourcePackResults).length > 0);
      if (hasKeyword && !hasResults) {
        searchClientMods();
      }
    }  }


  // Handle content type switching similar to server UI
  async function switchContentType(contentTypeId) {
    if ($activeContentType === contentTypeId) return;
    contentTypeSwitching.set(true);
    try {
      activeContentType.set(contentTypeId);
      // When switching content type, load relevant data for the current sub-tab
      if (activeTab === 'search') {
        // Ensure installed IDs/info are loaded for proper installed flags in search results
        try {
          await loadContent(instance?.path || '', contentTypeId);
        } catch (_) {}
        // Trigger search if keyword present
        if (get(searchKeyword)) {
          await searchClientMods();
        }
      } else if (activeTab === 'installed') {
        if (contentTypeId === CONTENT_TYPES.MODS) {
          await refreshInstalledMods(instance);
        } else {
          await refreshAssets();
        }
      }
    } finally {
      contentTypeSwitching.set(false);
    }
  }
  // Install selected mod and its dependencies using helper
  async function handleInstallWithDependencies() {
    try {
      const result = await installWithDependencies(instance?.path, clientInstallFn, 'mods');

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
      installingModIds.set(new SvelteSet());
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
  const dependencies = await checkModDependencies(modForInstall, new Set(), { interactive: true });
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

  // Enhance mod data with clean names from JAR files  
  // ...existing code...

  // Wrapper function for mod toggle that handles completion notification
  async function handleModToggleWrapper(instance, fileName, enabled) {
    try {
      // Add timeout to prevent infinite loading - increased to 15 seconds
      const timeoutPromise = new Promise((_, reject) => 
        setTimeout(() => reject(new Error('Toggle operation timed out')), 15000)
      );
      
      await Promise.race([
        handleModToggle(instance, fileName, enabled),
        timeoutPromise
      ]);
      
    } catch (error) {
      // Error handling is already done in the utility function
    } finally {
      // Always notify completion to remove loading state, regardless of success or failure
      // Use setTimeout to ensure components are ready
      setTimeout(() => {
        try {
          if (optionalModListComponent && typeof optionalModListComponent.onToggleComplete === 'function') {
            optionalModListComponent.onToggleComplete(fileName);
          }
          if (clientManualModListComponent && typeof clientManualModListComponent.onToggleComplete === 'function') {
            clientManualModListComponent.onToggleComplete(fileName);
          }
        } catch (completionError) {
          // Error during toggle completion
        }
      }, 100);
    }
  }

  // Handle mod removal event - refresh state to clear outdated mod data
  function handleModRemoved(event) {
    const { fileName } = event.detail;
    
    // Refresh mod data to update the UI state
    refreshMods();
    
    // Dispatch event to parent to trigger comprehensive state refresh
    dispatch('mod-removed', { fileName });
  }
</script>

<div class="client-mod-manager">
  <DownloadProgress />
  <ModDependencyModal on:install={handleInstallWithDependencies} />

  <!-- Content Type Tabs -->
  <div class="content-type-tabs" role="tablist">
    {#each [
      { id: CONTENT_TYPES.MODS, label: 'Mods', icon: '🧩' },
      { id: CONTENT_TYPES.SHADERS, label: 'Shaders', icon: '✨' },
      { id: CONTENT_TYPES.RESOURCE_PACKS, label: 'Resource Packs', icon: '🎨' }
    ] as contentType (contentType.id)}
      <button 
        type="button"
        class="content-type-tab" 
        class:active={$activeContentType === contentType.id}
        class:switching={$contentTypeSwitching && $activeContentType === contentType.id}
        disabled={$contentTypeSwitching}
        on:click={() => switchContentType(contentType.id)}
        aria-selected={$activeContentType === contentType.id}
        aria-controls="{contentType.id}-content-panel"
        id="{contentType.id}-content-tab"
        role="tab"
        tabindex={$activeContentType === contentType.id ? 0 : -1}
      >
        <span class="content-type-icon">
          {#if $contentTypeSwitching && $activeContentType === contentType.id}
            <span class="loading-spinner">⏳</span>
          {:else}
            {contentType.icon}
          {/if}
        </span>
        <span class="content-type-label">{contentType.label}</span>
      </button>
    {/each}
  </div>

  <!-- Sub Tabs -->
  <div class="mod-manager-tabs" role="tablist">
    <button 
      type="button"
      class="tab" 
      class:active={activeTab === 'installed'}
      on:click={() => switchTab('installed')}
      aria-selected={activeTab === 'installed'}
      aria-controls="installed-tab-panel"
      id="installed-tab"
      role="tab"
      tabindex={activeTab === 'installed' ? 0 : -1}
    >
      Installed {contentTypeConfigs[$activeContentType]?.label || 'Content'}
    </button>
    <button 
      type="button"
      class="tab" 
      class:active={activeTab === 'search'}
      on:click={() => switchTab('search')}
      aria-selected={activeTab === 'search'}
      aria-controls="search-tab-panel"
      id="search-tab"
      role="tab"
      tabindex={activeTab === 'search' ? 0 : -1}
    >
      Find {contentTypeConfigs[$activeContentType]?.label || 'Content'}
    </button>
  </div>

  <!-- Compact Status Header -->
  {#if activeTab === 'installed'}
    <div class="compact-status">
      {#if $activeContentType === CONTENT_TYPES.MODS}
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
            {@const optionalWork = ($modSyncStatus.missingOptionalMods?.length || 0) + ($modSyncStatus.outdatedOptionalMods?.length || 0)}
            <span class="status-item">Optional: {optionalWork > 0 ? '⚠️' : '✅'} {displayOptionalMods.length - optionalWork}/{displayOptionalMods.length}</span>
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
                <button class="compact-btn primary" on:click={() => handleBulkServerModRemoval(instance, actualRemovals.map(r => r.fileName))}>
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
      {:else}
        <div class="status-line">
          {#if $connectionStatus === 'connected'}
            <span class="status-item connected">🔗 Connected</span>
          {:else}
            <span class="status-item disconnected">❌ Disconnected</span>
          {/if}
          {#if $lastModCheck}
            <span class="status-item">Last sync: {$lastModCheck.toLocaleTimeString()}</span>
          {/if}
          {#if $activeContentType === CONTENT_TYPES.SHADERS}
            {@const missing = countMissingAssets(serverShaderItems, shaderAssets)}
            {@const updates = countOutdatedAssets(serverShaderItems, shaderAssets)}
            <span class="status-item">Required: {missing === 0 && updates === 0 && serverShaderItems.length > 0 ? '✅' : serverShaderItems.length === 0 ? '—' : '⚠️'} {serverShaderItems.length - missing}/{serverShaderItems.length}</span>
          {:else if $activeContentType === CONTENT_TYPES.RESOURCE_PACKS}
            {@const missing = countMissingAssets(serverResourcePackItems, resourcePackAssets)}
            {@const updates = countOutdatedAssets(serverResourcePackItems, resourcePackAssets)}
            <span class="status-item">Required: {missing === 0 && updates === 0 && serverResourcePackItems.length > 0 ? '✅' : serverResourcePackItems.length === 0 ? '—' : '⚠️'} {serverResourcePackItems.length - missing}/{serverResourcePackItems.length}</span>
          {/if}
        </div>
        <div class="status-actions">
          <button class="compact-btn" on:click={() => { refreshInstalledMods(instance); refreshAssets(); }}>
            🔄 Refresh
          </button>
          {#if $activeContentType === CONTENT_TYPES.SHADERS}
            {@const missing = countMissingAssets(serverShaderItems, shaderAssets)}
            {#if missing > 0}
              <button class="compact-btn primary" on:click={() => downloadRequiredAssets('shaderpacks')}>
                📥 Download Required ({missing})
              </button>
            {/if}
          {:else if $activeContentType === CONTENT_TYPES.RESOURCE_PACKS}
            {@const missing = countMissingAssets(serverResourcePackItems, resourcePackAssets)}
            {#if missing > 0}
              <button class="compact-btn primary" on:click={() => downloadRequiredAssets('resourcepacks')}>
                📥 Download Required ({missing})
              </button>
            {/if}
          {/if}
        </div>
      {/if}
    </div>
  {/if}

  <div class="mod-content">
    {#if activeTab === 'installed'}
      {#if $activeContentType === CONTENT_TYPES.MODS}
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
                on:downloadSingle={(e) => downloadSingleRequiredMod(instance, e.detail.mod)}
                on:remove={(e) => handleServerModRemoval(instance, e.detail.fileName)}
                on:acknowledge={(e) => handleDependencyAcknowledgment(instance, e.detail.fileName)}
                on:updateMod={(e) => updateServerMod(instance, e)}
              />
            </div>

            <!-- Optional Mods Section -->
            {#if displayOptionalMods.length > 0}
              <div class="mod-section">
                <ClientModList
                  bind:this={optionalModListComponent}
                  mods={displayOptionalMods}
                  type="optional"
                  modSyncStatus={$modSyncStatus}
                  serverManagedFiles={$serverManagedFiles}
                  on:toggle={(e) => handleModToggleWrapper(instance, e.detail.fileName, e.detail.enabled)}
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
                bind:this={clientManualModListComponent}
                clientPath={instance?.path || ''}
                refreshTrigger={manualModsRefreshTrigger}
                modSyncStatus={$modSyncStatus}
                {clientModVersionUpdates}
                on:toggle={(e) => handleModToggleWrapper(instance, e.detail.fileName, e.detail.enabled)}
                on:delete={(e) => handleModDelete(instance, e.detail.fileName)}
                on:install={handleInstallMod}
                on:mod-removed={handleModRemoved}
              />
            </div>
          </div>

          <!-- ModDropZone at the bottom -->
          <ModDropZone on:filesDropped={handleDroppedFiles} />
        {/if}
      {:else if $activeContentType === CONTENT_TYPES.SHADERS}
        <div class="mod-sections">
          <!-- Required Shaders (from server) -->
          <div class="mod-section">
            <ClientAssetList
              mode="required"
              title="Required Shaders"
              description="These shaders are managed by the server. Items marked To Remove will be deleted."
              items={requiredShaderItemsExtended}
              installedItems={shaderAssets}
              on:download={(async (e) => { const it = e.detail.item; try { console.log('[ClientModManager] Download click (shader)', it.fileName); } catch {} await window.electron.invoke('minecraft-download-assets', { clientPath: instance.path, type: 'shaderpacks', requiredItems: [it], serverInfo: { serverIp: instance.serverIp, serverPort: instance.serverPort, serverProtocol: instance.serverProtocol, sessionToken: instance.sessionToken }}); try { console.log('[ClientModManager] Download done (shader)', it.fileName); } catch {} await refreshAssets(); notifyAssetsChanged(); dispatch('asset-changed', { type: 'shaderpacks', action: 'download', fileName: it.fileName }); })}
              on:remove={(async (e) => { const it = e.detail.item; try { console.log('[ClientModManager] Remove click (shader)', it.fileName); } catch {} await window.electron.invoke('delete-client-asset', { clientPath: instance.path, type: 'shaderpacks', fileName: it.fileName }); try { console.log('[ClientModManager] Remove done (shader)', it.fileName); } catch {} await refreshAssets(); notifyAssetsChanged(); dispatch('asset-changed', { type: 'shaderpacks', action: 'remove', fileName: it.fileName }); })}
              on:install-asset-version={handleInstallAssetVersion}
            />
          </div>

          <!-- Client Downloaded Shaders -->
          <div class="mod-section">
              <ClientAssetList
              mode="client"
              title="Client Downloaded Shaders"
              items={extraShaders}
                on:delete={(e) => { const { item } = e.detail; pendingAssetDelete = { type: 'shaderpacks', fileName: item.fileName }; showAssetDeleteConfirm = true; }}
              on:install-asset-version={handleInstallAssetVersion}
            />
          </div>

          <!-- Drop zone visual parity -->
          <ModDropZone disabled={true} />
        </div>
      {:else if $activeContentType === CONTENT_TYPES.RESOURCE_PACKS}
        <div class="mod-sections">
          <!-- Required Resource Packs (from server) -->
          <div class="mod-section">
            <ClientAssetList
              mode="required"
              title="Required Resource Packs"
              description="These resource packs are managed by the server. Items marked To Remove will be deleted."
              items={requiredResourcePackItemsExtended}
              installedItems={resourcePackAssets}
              on:download={(async (e) => { const it = e.detail.item; try { console.log('[ClientModManager] Download click (rp)', it.fileName); } catch {} await window.electron.invoke('minecraft-download-assets', { clientPath: instance.path, type: 'resourcepacks', requiredItems: [it], serverInfo: { serverIp: instance.serverIp, serverPort: instance.serverPort, serverProtocol: instance.serverProtocol, sessionToken: instance.sessionToken }}); try { console.log('[ClientModManager] Download done (rp)', it.fileName); } catch {} await refreshAssets(); notifyAssetsChanged(); dispatch('asset-changed', { type: 'resourcepacks', action: 'download', fileName: it.fileName }); })}
              on:remove={(async (e) => { const it = e.detail.item; try { console.log('[ClientModManager] Remove click (rp)', it.fileName); } catch {} await window.electron.invoke('delete-client-asset', { clientPath: instance.path, type: 'resourcepacks', fileName: it.fileName }); try { console.log('[ClientModManager] Remove done (rp)', it.fileName); } catch {} await refreshAssets(); notifyAssetsChanged(); dispatch('asset-changed', { type: 'resourcepacks', action: 'remove', fileName: it.fileName }); })}
              on:install-asset-version={handleInstallAssetVersion}
            />
          </div>

          <!-- Client Downloaded Resource Packs -->
          <div class="mod-section">
              <ClientAssetList
              mode="client"
              title="Client Downloaded Resource Packs"
              items={extraRps}
                on:delete={(e) => { const { item } = e.detail; pendingAssetDelete = { type: 'resourcepacks', fileName: item.fileName }; showAssetDeleteConfirm = true; }}
              on:install-asset-version={handleInstallAssetVersion}
            />
          </div>

          <!-- Drop zone visual parity -->
          <ModDropZone disabled={true} />
        </div>
      {/if}
    {:else if activeTab === 'search'}
      <!-- Client content finding and installation -->
      <div class="mod-search-section">
        <ModSearch
          on:install={handleInstallMod}
          serverPath={instance?.path || ""}
          serverManagedSet={
            $activeContentType === CONTENT_TYPES.SHADERS
              ? new Set((serverShaderItems || []).map(it => (it.fileName || '').toLowerCase().split(/[\\\/]/).pop()))
              : $activeContentType === CONTENT_TYPES.RESOURCE_PACKS
                ? new Set((serverResourcePackItems || []).map(it => (it.fileName || '').toLowerCase().split(/[\\\/]/).pop()))
                : $serverManagedFiles
          }
        />
      </div>
    {/if}
  </div>
</div>

<!-- Delete Confirmation Dialog for client assets -->
<ConfirmationDialog
  bind:visible={showAssetDeleteConfirm}
  title="Delete Asset"
  message={pendingAssetDelete ? `Are you sure you want to delete ${pendingAssetDelete.fileName}?` : ''}
  confirmText="Delete"
  cancelText="Cancel"
  on:confirm={async () => {
    if (!pendingAssetDelete) return;
    try {
      await window.electron.invoke('delete-client-asset', {
        clientPath: instance.path,
        type: pendingAssetDelete.type,
        fileName: pendingAssetDelete.fileName
      });
      await refreshAssets();
      notifyAssetsChanged();
    } finally {
      pendingAssetDelete = null;
      showAssetDeleteConfirm = false;
    }
  }}
  on:cancel={() => { pendingAssetDelete = null; showAssetDeleteConfirm = false; }}
/>

<style>
  .client-mod-manager {
    width: 100%;
    max-width: 100%;
    margin: 0 auto;
    padding: 1rem;
    box-sizing: border-box;
    overflow-x: hidden;
  }

  .content-type-tabs {
    display: flex;
    background: var(--tab-container-bg);
    border-radius: var(--tab-container-border-radius);
    padding: var(--tab-container-padding);
    border: var(--tab-container-border);
    justify-content: center;
    gap: var(--tab-container-gap);
    margin-bottom: 0.5rem;
  }

  .content-type-tab {
    width: var(--tab-button-width) !important;
    min-width: var(--tab-button-width) !important;
    max-width: var(--tab-button-width) !important;
    min-height: var(--tab-button-min-height);
    padding: var(--tab-button-padding) !important;
    margin: var(--tab-button-margin) !important;
    border: var(--tab-inactive-border);
    border-radius: var(--tab-button-border-radius);
    font-size: var(--tab-button-font-size);
    font-weight: var(--tab-button-font-weight);
    cursor: pointer;
    transition: var(--tab-button-transition);
    background: var(--tab-inactive-bg);
    color: var(--tab-inactive-color);
    box-sizing: border-box !important;
    flex-shrink: 0 !important;
    display: flex;
    align-items: center;
    justify-content: center;
    text-align: center;
    flex-direction: column;
    gap: 0.25rem;
  }

  .content-type-tab.active {
    background: var(--tab-active-bg);
    color: var(--tab-active-color);
    border: var(--tab-active-border);
  }

  .content-type-tab:hover:not(.active) {
    background: var(--tab-hover-bg);
    color: var(--tab-hover-color);
    transform: var(--tab-hover-transform);
  }

  .content-type-tab.active:hover {
    background: var(--tab-active-hover-bg);
    border: var(--tab-active-hover-border);
  }

  .content-type-tab:disabled {
    opacity: 0.7;
    cursor: not-allowed;
  }

  .content-type-tab.switching {
    opacity: 0.8;
  }

  .loading-spinner {
    display: inline-block;
    animation: spin 1s linear infinite;
  }

  @keyframes spin {
    from { transform: rotate(0deg); }
    to { transform: rotate(360deg); }
  }

  .content-type-icon {
    font-size: 1.2em;
    line-height: 1;
  }

  .content-type-label {
    font-size: 0.85em;
    line-height: 1;
  }

  .mod-manager-tabs {
    display: flex;
    background: var(--tab-container-bg);
    border-radius: var(--tab-container-border-radius);
    padding: var(--tab-container-padding);
    border: var(--tab-container-border);
    justify-content: center;
    gap: var(--tab-container-gap);
    margin: 0;
  }

  .tab {
    width: var(--tab-button-width) !important;
    min-width: var(--tab-button-width) !important;
    max-width: var(--tab-button-width) !important;
    min-height: var(--tab-button-min-height);
    padding: var(--tab-button-padding) !important;
    margin: var(--tab-button-margin) !important;
    border: var(--tab-inactive-border);
    border-radius: var(--tab-button-border-radius);
    font-size: var(--tab-button-font-size);
    font-weight: var(--tab-button-font-weight);
    cursor: pointer;
    transition: var(--tab-button-transition);
    background: var(--tab-inactive-bg);
    color: var(--tab-inactive-color);
    box-sizing: border-box !important;
    flex-shrink: 0 !important;
    display: flex;
    align-items: center;
    justify-content: center;
    text-align: center;
  }

  .tab.active {
    background: var(--tab-active-bg);
    color: var(--tab-active-color);
    border: var(--tab-active-border);
  }

  .tab:hover:not(.active) {
    background: var(--tab-hover-bg);
    color: var(--tab-hover-color);
    transform: var(--tab-hover-transform);
  }

  .tab.active:hover {
    background: var(--tab-active-hover-bg);
    border: var(--tab-active-hover-border);
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
    width: 100%;
    max-width: 100%;
    box-sizing: border-box;
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


  .mod-search-section {
    padding: 1.5rem;
    background-color: #1f2937;
    border-radius: 8px;
    border: 1px solid #374151;
    width: 100%;
    max-width: 100%;
    box-sizing: border-box;
    overflow-x: hidden;
  }

  .error-message {
    color: #ef4444;
    margin-bottom: 1rem;
  }

  /* Responsive Design */
  @media (max-width: 768px) {
    .compact-status {
      flex-direction: column;
      gap: 1rem;
      align-items: stretch;
    }

    .status-line {
      justify-content: center;
      gap: 0.75rem;
    }

    .status-actions {
      justify-content: center;
      flex-wrap: wrap;
    }
  }

</style>
