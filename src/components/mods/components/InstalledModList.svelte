<script>
  import { createEventDispatcher, onMount, onDestroy } from 'svelte';
  import { get } from 'svelte/store';
  
  import { SvelteSet, SvelteMap } from 'svelte/reactivity';import { fly } from 'svelte/transition';
  
  // Import existing stores
  import {
    installedMods,
    installedModInfo,
    modsWithUpdates,
    expandedInstalledMod,
    isCheckingUpdates,
    isLoading,
    successMessage,
    errorMessage,
    disabledMods,
    disabledModUpdates,
    getCategorizedMods,
    updateModCategory,
    updateModRequired,
    loadModCategories,
    activeContentType,
    CONTENT_TYPES,
    installedShaders,
    installedResourcePacks,
    installedShaderInfo,
    installedResourcePackInfo,
    loaderType,
    minecraftVersion,
    ignoreUpdate
  } from '../../../stores/modStore.js';
  import { serverState } from '../../../stores/serverState.js';
  import { formatInstallationDate, formatLastUpdated, formatTooltipDate } from '../../../utils/dateUtils.js';
  
  // Import existing API functions
  import { loadMods, loadContent, deleteMod, deleteContent, checkForUpdates, enableAndUpdateMod, fetchModVersions, checkDisabledModUpdates } from '../../../utils/mods/modAPI.js';
  import { safeInvoke } from '../../../utils/ipcUtils.js';
  import { checkDependencyCompatibility, checkVersionCompatibility } from '../../../utils/mods/modCompatibility.js';
  import { checkModDependencies } from '../../../utils/mods/modDependencyHelper.js';

  
  // Import confirmation dialog
  import ConfirmationDialog from '../../common/ConfirmationDialog.svelte';

  // Import Modrinth matching components
  import ModrinthMatchConfirmation from './ModrinthMatchConfirmation.svelte';
  import ModrinthManualMatchingModal from './ModrinthManualMatchingModal.svelte';
  import { 
    modrinthMatchingActions, 
    confirmedModrinthMatches,
    pendingModrinthConfirmations
  } from '../../../stores/modrinthMatchingStore.js';
  import { clientState } from '../../../stores/clientStore.js';

  // Props
  export let serverPath = '';

  // Event dispatcher
  const dispatch = createEventDispatcher();

  // Local state
  let selectedMods = new SvelteSet();
  let installedModVersionsCache = {};
  let confirmDeleteVisible = false;
  let modToDelete = null;

  let updateAllInProgress = false;
  let checkingCompatibility = false;
  let compatibilityResults = null;
  let bulkDownloadInProgress = false;
  let bulkDownloadProgress = 0;  
  
  // Initialize drop zone state from localStorage
  let dropZoneCollapsed = localStorage.getItem('minecraft-core-drop-zone-collapsed') === 'true';
  
  // State for enhancements  
  let searchTerm = '';
  let isDragover = false;

  // Get stores 
  const categorizedModsStore = getCategorizedMods();

  // Reactive list of installed info based on content type (ensures proper reactivity on first load)
  $: currentInfoList = $activeContentType === CONTENT_TYPES.SHADERS
    ? $installedShaderInfo
    : $activeContentType === CONTENT_TYPES.RESOURCE_PACKS
      ? $installedResourcePackInfo
      : $installedModInfo;

  // Track if we've attempted to load version info to prevent infinite loops
  let versionLoadAttempted = false;
  let loadingVersionInfo = false;
  // Defer short loads to avoid UI flicker in the Current column
  let showLoadingIndicator = false;
  let loadingTimer = null;
  // Also suppress Modrinth matching UI for a brief window right after load completes
  let suppressMatchingUi = false;
  let suppressTimer = null;
  // Additionally, suppress initial UI swaps right after this component mounts (e.g., when switching tabs)
  let initialUiSuppression = true;
  let initialSuppressionTimer = null;

  // Last-known versions cache to render instantly without flicker
  const LAST_VERSIONS_KEY = 'minecraft-core:last-known-versions';
  let lastVersionsCache = {};
  let saveCacheTimer = null;

  function cacheKey(contentType, server) {
    return `${server || ''}::${contentType || 'MODS'}`;
  }
  function loadLastVersions() {
    try {
      const raw = localStorage.getItem(LAST_VERSIONS_KEY);
      lastVersionsCache = raw ? JSON.parse(raw) : {};
    } catch {
      lastVersionsCache = {};
    }
  }
  function scheduleSaveCache() {
    if (saveCacheTimer) clearTimeout(saveCacheTimer);
    saveCacheTimer = setTimeout(() => {
      try { localStorage.setItem(LAST_VERSIONS_KEY, JSON.stringify(lastVersionsCache)); } catch {}
      saveCacheTimer = null;
    }, 200);
  }
  function setCachedVersion(fileName, version, contentType = $activeContentType) {
    if (!fileName || !version) return;
    const key = cacheKey(contentType, serverPath);
    if (!lastVersionsCache[key]) lastVersionsCache[key] = {};
    if (lastVersionsCache[key][fileName] === version) return;
    lastVersionsCache[key][fileName] = version;
    scheduleSaveCache();
  }
  function getCachedVersion(fileName, contentType = $activeContentType) {
    const key = cacheKey(contentType, serverPath);
    return (lastVersionsCache[key] && lastVersionsCache[key][fileName]) || null;
  }
  function removeCachedVersion(fileName, contentType = $activeContentType) {
    const key = cacheKey(contentType, serverPath);
    if (lastVersionsCache[key] && lastVersionsCache[key][fileName]) {
      delete lastVersionsCache[key][fileName];
      scheduleSaveCache();
    }
  }

  // Imperative grace handler to avoid reactive loop warnings
  let _prevBusy = false;
  function updateLoadingGrace() {
    const busy = get(isLoading) || loadingVersionInfo;
    // Track transitions to set a short post-load suppression window
    if (!_prevBusy && busy) {
      // Loading started
      if (!loadingTimer) {
        loadingTimer = setTimeout(() => {
          showLoadingIndicator = true;
        }, 250);
      }
      // Cancel any suppression when loading starts again
      if (suppressTimer) {
        clearTimeout(suppressTimer);
        suppressTimer = null;
      }
      suppressMatchingUi = false;
  } else if (_prevBusy && !busy) {
      // Loading just finished
      if (loadingTimer) {
        clearTimeout(loadingTimer);
        loadingTimer = null;
      }
      showLoadingIndicator = false;
      // Start brief suppression to avoid UI flicker as data settles
      suppressMatchingUi = true;
      if (suppressTimer) clearTimeout(suppressTimer);
      suppressTimer = setTimeout(() => {
        suppressMatchingUi = false;
        suppressTimer = null;
      }, 200);
    } else if (!busy) {
      // Idle steady state
      if (loadingTimer) {
        clearTimeout(loadingTimer);
        loadingTimer = null;
      }
      showLoadingIndicator = false;
    }
  _prevBusy = busy;
  }

  // Subscribe to global isLoading changes to keep indicator in sync
  let unsubscribeIsLoading;
  onMount(() => {
  // Load cache on mount
  loadLastVersions();

    // Initial mount suppression to avoid brief UI swap when returning to the tab
    initialUiSuppression = true;
    if (initialSuppressionTimer) clearTimeout(initialSuppressionTimer);
    initialSuppressionTimer = setTimeout(() => {
      initialUiSuppression = false;
      initialSuppressionTimer = null;
    }, 300);

    unsubscribeIsLoading = isLoading.subscribe(() => {
      updateLoadingGrace();
    });
  });

  // Function to check and load version info if needed
  async function checkAndLoadVersionInfo(contentType, serverPathParam) {
    if (versionLoadAttempted || loadingVersionInfo || !serverPathParam || !contentType) {
      return;
    }

    // Get current values without reactive access
    const currentInfo = getCurrentInfoStore();
    let currentItems = [];
    
    try {
      if (contentType === CONTENT_TYPES.SHADERS) {
        currentItems = get(installedShaders) || [];
      } else if (contentType === CONTENT_TYPES.RESOURCE_PACKS) {
        currentItems = get(installedResourcePacks) || [];
      } else {
        currentItems = get(installedMods) || [];
      }
    } catch (error) {
      // Error getting current items
      return;
    }
    
    // If we have installed items but no version info, trigger a refresh
    if (currentItems.length > 0 && (!currentInfo || currentInfo.length === 0 || currentInfo.every(info => !info || !info.versionNumber))) {
      versionLoadAttempted = true;

      
      try {
  loadingVersionInfo = true;
  updateLoadingGrace();
        if (contentType === CONTENT_TYPES.MODS) {
          await loadMods(serverPathParam);
        } else {
          await loadContent(serverPathParam, contentType);
        }
        // Reset the flag after a delay to allow future refreshes if needed
        setTimeout(() => {
          versionLoadAttempted = false;
        }, 2000);
      } catch (error) {
        // Failed to refresh version info
        versionLoadAttempted = false;
      } finally {
  loadingVersionInfo = false;
  updateLoadingGrace();
      }
    }
  }

  // Track content type changes to trigger version loading
  let lastActiveContentType = $activeContentType;

  // Helper function to get the appropriate info store based on content type
  function getCurrentInfoStore() {
    switch ($activeContentType) {
      case CONTENT_TYPES.SHADERS:
        return $installedShaderInfo || [];
      case CONTENT_TYPES.RESOURCE_PACKS:
        return $installedResourcePackInfo || [];
      case CONTENT_TYPES.MODS:
      default:
        return $installedModInfo || [];
    }
  }

  // Update cache whenever fresh version info arrives
  $: if (currentInfoList && currentInfoList.length) {
    for (const info of currentInfoList) {
      if (info && info.fileName && info.versionNumber && info.versionNumber !== 'Unknown') {
        setCachedVersion(info.fileName, info.versionNumber);
      }
    }
  }

  // Briefly suppress UI only when content type actually changes
  $: if ($activeContentType !== undefined && $activeContentType !== lastActiveContentType) {
    suppressUiBriefly(250);
    lastActiveContentType = $activeContentType;
  }

  function suppressUiBriefly(ms = 250) {
    // Start suppression for both matching UI and initial placeholders
    suppressMatchingUi = true;
    initialUiSuppression = true;
    if (suppressTimer) clearTimeout(suppressTimer);
    if (initialSuppressionTimer) clearTimeout(initialSuppressionTimer);
    suppressTimer = setTimeout(() => { suppressMatchingUi = false; suppressTimer = null; }, ms);
    initialSuppressionTimer = setTimeout(() => { initialUiSuppression = false; initialSuppressionTimer = null; }, ms);
  }

  // Cleanup any pending timers
  onDestroy(() => {
    if (loadingTimer) {
      clearTimeout(loadingTimer);
      loadingTimer = null;
    }
    if (suppressTimer) {
      clearTimeout(suppressTimer);
      suppressTimer = null;
    }
    if (initialSuppressionTimer) {
      clearTimeout(initialSuppressionTimer);
      initialSuppressionTimer = null;
    }
    if (unsubscribeIsLoading) {
      unsubscribeIsLoading();
      unsubscribeIsLoading = null;
    }
    if (saveCacheTimer) {
      clearTimeout(saveCacheTimer);
      saveCacheTimer = null;
    }
  });



  // Generate enhanced tooltip content with installation date information
  function generateVersionTooltip(modInfo) {
    if (!modInfo || !modInfo.versionNumber) {
      return 'No version information available';
    }

    let tooltip = `Version: ${modInfo.versionNumber}`;
    
    // Add installation date information with improved formatting
    const installDate = modInfo.installationDate || modInfo.installedAt || modInfo.dateInstalled;
    if (installDate) {
      try {
        const friendlyDate = formatTooltipDate(installDate);
        const relativeDate = formatInstallationDate(installDate);
        tooltip += `\n\nInstalled: ${friendlyDate}`;
        tooltip += `\n(${relativeDate})`;
      } catch (error) {
        // Error formatting installation date
        tooltip += `\n\nInstallation date: ${installDate}`;
      }
    } else {
      tooltip += `\n\nInstallation date: Unknown`;
    }
    
    // Add last updated information if different from installation
    if (modInfo.lastUpdated && modInfo.lastUpdated !== installDate) {
      try {
        const friendlyUpdateDate = formatTooltipDate(modInfo.lastUpdated);
        const relativeUpdateDate = formatLastUpdated(modInfo.lastUpdated);
        tooltip += `\n\nLast Updated: ${friendlyUpdateDate}`;
        tooltip += `\n(${relativeUpdateDate})`;
      } catch (error) {
        // Error formatting last updated date
        tooltip += `\n\nLast Updated: ${modInfo.lastUpdated}`;
      }
    }
    
    return tooltip;
  }

  function normalizeFileName(name) {
    if (!name) return '';
    return String(name).split(/[\\/]/).pop();
  }

  function findDisabledUpdate(updates, modName) {
    if (!updates || typeof updates.has !== 'function' || !modName) return null;
    if (updates.has(modName)) return updates.get(modName);
    const normalized = normalizeFileName(modName);
    if (normalized && normalized !== modName && updates.has(normalized)) {
      return updates.get(normalized);
    }
    return null;
  }

  // Reactive values for content-type specific data
  $: currentInstalledItems = $activeContentType === CONTENT_TYPES.SHADERS ? $installedShaders :
                            $activeContentType === CONTENT_TYPES.RESOURCE_PACKS ? $installedResourcePacks :
                            $installedMods;
  
  // Content-type specific update count
  $: updateCount = (() => {
    const allUpdates = $modsWithUpdates;
    const currentItems = $activeContentType === CONTENT_TYPES.SHADERS ? $installedShaders :
                        $activeContentType === CONTENT_TYPES.RESOURCE_PACKS ? $installedResourcePacks :
                        $installedMods;

    let count = 0;
    for (const [fileName] of allUpdates.entries()) {
      if (fileName.startsWith('project:')) continue;
      if (currentItems.includes(fileName)) {
        count++;
      }
    }

    if ($activeContentType === CONTENT_TYPES.MODS && $disabledModUpdates) {
      const disabledSet = $disabledMods;
      const modNames = $installedModInfo ? new Set($installedModInfo.map(m => m.fileName)) : null;
      for (const name of $disabledModUpdates.keys()) {
        if ((modNames && modNames.has(name)) || (disabledSet && disabledSet.has && disabledSet.has(name))) {
          count++;
        }
      }
    }

    return count;
  })();
  $: serverRunning = $serverState.status === 'Running';
  
  // Reactive statement to load content when content type changes
  $: if ($activeContentType && serverPath) {
    (async () => {
      try {
        if ($activeContentType === CONTENT_TYPES.MODS) {
          await loadMods(serverPath);
          try { await checkDisabledModUpdates(serverPath); } catch {}
        } else {
          await loadContent(serverPath, $activeContentType);
        }
      } catch (error) {
        // Silently handle content loading errors
      }
    })();
  }
  
  // Auto-collapse drop zone after successful mod upload
  $: if (currentInstalledItems.length > 0) {
    // Only auto-collapse if we haven't done so already
    if (!localStorage.getItem('minecraft-core-drop-zone-collapsed')) {
      dropZoneCollapsed = true;
      localStorage.setItem('minecraft-core-drop-zone-collapsed', 'true');
    }
  }
  
  // Filter items based on search term
  $: filteredMods = currentInstalledItems.filter(mod => {
    if (!searchTerm) return true;
    const modInfo = currentInfoList.find(m => m.fileName === mod);
    const modCategoryInfo = $categorizedModsStore.find(m => m.fileName === mod);
    const searchLower = searchTerm.toLowerCase();
    
    return (
      mod.toLowerCase().includes(searchLower) ||
      (modInfo?.name && modInfo.name.toLowerCase().includes(searchLower)) ||
      (modCategoryInfo?.name && modCategoryInfo.name.toLowerCase().includes(searchLower))
    );
  });
  
  function toggleDropZone() {
    dropZoneCollapsed = !dropZoneCollapsed;
  }
  
  // Enhanced drag and drop handlers
  function handleDragOver(event) {
    event.preventDefault();
    if (!isDragover) {
      isDragover = true;
    }
  }

  function handleDragLeave(event) {
    // Only hide highlight if leaving the component entirely
    if (!event.currentTarget.contains(event.relatedTarget)) {
      isDragover = false;
    }
  }

  function handleDrop(event) {
    event.preventDefault();
    isDragover = false;
    
    const files = event.dataTransfer?.files;
    if (!files || files.length === 0) return;
    
    // Filter for JAR files
    const jarFiles = Array.from(files).filter(file => 
      file.name.toLowerCase().endsWith('.jar')
    );
    
    if (jarFiles.length === 0) {
      errorMessage.set('No valid JAR files found.');
      return;
    }
    
    installModFiles(jarFiles);
  }

  // Handle drag enter on the add mods button
  function handleAddButtonDragEnter(event) {
    event.preventDefault();
    isDragover = true;
  }



  // Check if mod has compatibility issues (placeholder for now)
  function hasCompatibilityIssues(_mod) {
    // This would integrate with your existing compatibility checking logic
    // For now, return false as a placeholder
    return false;
  }
  

  
  // Handle file input change
  function handleBrowseFiles() {
    // Simple file selection without type issues
    const input = document.createElement('input');
    input.type = 'file';
    input.multiple = true;
    input.accept = '.jar';
    
    input.onchange = (event) => {
      const target = event.target;
      const files = target && target['files'];
      if (!files || files.length === 0) return;
      
      // Filter for JAR files
      const jarFiles = Array.from(files).filter(file => 
        file.name.toLowerCase().endsWith('.jar')
      );
      
      if (jarFiles.length === 0) {
        errorMessage.set('No valid JAR files found.');
        return;
      }
      
      installModFiles(jarFiles);
    };
    
    input.click();
  }

  // Install mod files (used by both drag&drop and browse)
  async function installModFiles(files) {
    try {
      successMessage.set(`Installing ${files.length} mod file(s)...`);
      
      const installedMods = [];
      
      for (const file of files) {
        const result = await safeInvoke('add-mod', serverPath, file.path);
        if (result && result.success) {
          installedMods.push({
            fileName: result.fileName,
            targetPath: result.targetPath,
            originalPath: file.path
          });
        }
      }
      
      // Refresh the mod list
      await loadMods(serverPath);
      dispatch('modAdded');
      
      // Trigger Modrinth matching for each installed mod
      for (const mod of installedMods) {
        await triggerModrinthMatching(mod.fileName, mod.targetPath);
      }
      
      successMessage.set(`Successfully installed ${files.length} mod(s)!`);
      
      // Collapse the drop zone after successful installation
      dropZoneCollapsed = true;
      localStorage.setItem('minecraft-core-drop-zone-collapsed', 'true');
    } catch (error) {
      errorMessage.set(`Error installing mod files: ${error.message || 'Unknown error'}`);
    }
  }

  // Trigger Modrinth matching for a newly added mod
  async function triggerModrinthMatching(fileName, modPath) {
    try {
      // Set checking state
      modrinthMatchingActions.setSearchState(fileName, 'checking');
      
      const result = await safeInvoke('search-modrinth-matches', {
        modPath,
        modName: fileName.replace(/\.jar$/i, ''),
        modVersion: null,
        loader: get(loaderType)
      });

      if (result && result.success && result.matches && result.matches.length > 0) {
        const topMatch = result.matches[0];
        
        // If we have any reasonable match, set up a pending confirmation
        if (topMatch.matchScore > 0.3) {
          const setPendingResult = await safeInvoke('set-mod-pending-confirmation', {
            fileName,
            matches: result.matches,
            metadata: result.metadata,
            searchedName: result.searchedName,
            searchedVersion: result.searchedVersion
          });
          
          if (setPendingResult && setPendingResult.success) {
            // Immediately refresh pending confirmations to show UI
            await modrinthMatchingActions.loadPendingConfirmations();
          }
          
          // Set found state and clear search state after a short delay to show the result
          modrinthMatchingActions.setSearchState(fileName, 'found');
          setTimeout(() => {
            modrinthMatchingActions.clearSearchState(fileName);
          }, 1000);
        } else {
          // Low confidence matches - show as no matches
          modrinthMatchingActions.setSearchState(fileName, 'no-matches');
        }
      } else {
        modrinthMatchingActions.setSearchState(fileName, 'no-matches');
      }
    } catch (error) {
      modrinthMatchingActions.setSearchState(fileName, 'failed', { error: error.message });
    }
  }

  // Modrinth matching event handlers
  async function handleMatchConfirmed(event) {
    const { fileName, match } = event.detail;
    
    try {
      const result = await modrinthMatchingActions.confirmMatch(fileName, match.project_id, match);
      if (result) {        
        // Clear all related states immediately
        modrinthMatchingActions.clearSearchState(fileName);
        
        // Refresh both stores to update UI immediately
        await Promise.all([
          modrinthMatchingActions.loadPendingConfirmations(),
          modrinthMatchingActions.loadConfirmedMatches()
        ]);
      }
    } catch (error) {
    }
  }

  async function handleMatchRejected(event) {
    const { fileName } = event.detail;
    
    try {
      const result = await modrinthMatchingActions.rejectMatch(fileName);
      if (result) {
        // Clear the pending confirmation from UI
        await modrinthMatchingActions.loadPendingConfirmations();
      }
    } catch (error) {
      // do nothing
    }
  }

  // Handle auto search trigger
  async function handleTriggerAutoSearch(event) {
    const { fileName } = event.detail;
    
    const modPath = `${serverPath}/mods/${fileName}`;
    await triggerModrinthMatching(fileName, modPath);
  }

  // Handle manual search trigger
  function handleTriggerManualSearch(event) {
    const { fileName } = event.detail;
    
    // Find the mod data for this fileName
    const modData = findModData(fileName);
    
    modrinthMatchingActions.showManualMatchingModal(modData || { fileName });
  }

  function findModData(fileName) {
    // Check in installed mods first
    if ($clientState.installedMods) {
      const found = $clientState.installedMods.find(mod => mod.fileName === fileName);
      if (found) {
        return { fileName, ...found };
      }
    }
    
    // Check pending match data
    const pendingData = $pendingModrinthConfirmations.get(fileName);
    if (pendingData) {
      return { fileName, pendingData };
    }
    
    // Return basic structure
    return { fileName };
  }

  // Function to reset a confirmed match and re-trigger matching
  async function resetModMatch(fileName) {
    try {
      const success = await modrinthMatchingActions.resetMatchingDecision(fileName);
      if (success) {
        // Refresh confirmed matches
        await modrinthMatchingActions.loadConfirmedMatches();
        
        // Re-trigger Modrinth matching for this mod
        const modPath = `${serverPath}/mods/${fileName}`;
        await triggerModrinthMatching(fileName, modPath);
      }
    } catch (error) {
    }
  }

  // Helper functions
  const locColor = { 
    'server-only': '#2c82ff', 
    'client-only': '#34d58a', 
    'both': '#f5aa28' 
  };

  function toggleSelect(modName) {
    if (selectedMods.has(modName)) {
      selectedMods.delete(modName);
    } else {
      selectedMods.add(modName);
    }
    selectedMods = new SvelteSet(selectedMods);
  }



  function toggleSelectAll() {
    if (selectedMods.size === filteredMods.length) {
      selectedMods = new SvelteSet();
    } else {
      selectedMods = new SvelteSet(filteredMods);
    }
  }



  // Mod management functions
  async function handleCheckUpdates() {
    try {
      // Ensure all content types are loaded so updates cover resource packs & shaders too
      await loadMods(serverPath); // mods first
      await Promise.allSettled([
        loadContent(serverPath, 'shaders'),
        loadContent(serverPath, 'resourcepacks')
      ]);
      // Force fresh data when user explicitly clicks "Check for Updates"
      await checkForUpdates(serverPath, true);
      successMessage.set('Update check completed successfully!');
      setTimeout(() => successMessage.set(''), 3000);
    } catch (error) {
      errorMessage.set(`Failed to check for updates: ${error.message}`);
    }
  }

  async function checkAllModsCompatibility() {
    if (checkingCompatibility) return;
    
    checkingCompatibility = true;
    compatibilityResults = null;
    
    try {
      const modsWithInfo = $installedModInfo.filter(mod => 
        mod.projectId && 
        mod.fileName && 
        !$disabledMods.has(mod.fileName)
      );
      
      if (modsWithInfo.length === 0) {
        successMessage.set('No enabled mods with project information found');
        return;
      }
      
      successMessage.set('Checking mod compatibility...');
      
      const allIssues = [];
      let checkedCount = 0;
      
      for (const mod of modsWithInfo) {
        try {
          if (!mod.projectId || !mod.fileName) continue;
          
          const deps = await checkModDependencies({
            id: mod.projectId,
            selectedVersionId: mod.versionId,
            source: mod.source || 'modrinth'
          }, new Set(), { interactive: true });
          checkedCount++;
          
          if (deps && deps.length > 0) {
            const issues = await checkDependencyCompatibility(deps, mod.projectId);
            if (issues.length > 0) {
              allIssues.push({
                mod: mod.fileName,
                modName: mod.name || mod.fileName,
                issues
              });
            }
          }
        } catch (error) {
        }
      }
      
      // Store results for display
      compatibilityResults = {
        totalChecked: checkedCount,
        totalIssues: allIssues.flatMap(i => i.issues).length,
        modsWithIssues: allIssues.length,
        issues: allIssues
      };
      
      if (allIssues.length > 0) {
        successMessage.set(`Found ${allIssues.flatMap(i => i.issues).length} compatibility issues in ${allIssues.length} mods - see details below`);
      } else {
        successMessage.set(`All mods compatible! Checked ${checkedCount} enabled mods.`);
      }
    } catch (error) {
      errorMessage.set(`Failed to check compatibility: ${error.message}`);
    } finally {
      checkingCompatibility = false;
    }
  }

  async function updateAllMods() {
    const enabledModsToUpdate = [];
    const disabledModsToUpdate = [];
    
    // Collect enabled mods with updates
    for (const [modName, updateInfo] of $modsWithUpdates.entries()) {
      if (modName.startsWith('project:')) continue;
      if ($disabledMods.has(modName)) continue; // Skip disabled mods here, we'll handle them separately
      
      const modInfo = getCurrentInfoStore().find(m => m.fileName === modName);
      if (modInfo && modInfo.projectId) {
        enabledModsToUpdate.push({
          modName,
          projectId: modInfo.projectId,
          versionId: updateInfo.id,
          version: updateInfo
        });
      }
    }
    
    // Collect disabled mods with updates
    for (const [modName, updateInfo] of $disabledModUpdates.entries()) {
      disabledModsToUpdate.push({
        modName,
        projectId: updateInfo.projectId,
        targetVersion: updateInfo.latestVersion,
        targetVersionId: updateInfo.latestVersionId
      });
    }
    
    const totalMods = enabledModsToUpdate.length + disabledModsToUpdate.length;
    if (totalMods === 0) return;
    
    updateAllInProgress = true;
    
    try {
      let updatedCount = 0;
      
      // Update enabled mods
      for (const mod of enabledModsToUpdate) {
        await dispatch('updateMod', {
          modName: mod.modName,
          projectId: mod.projectId,
          versionId: mod.versionId
        });
        updatedCount++;
      }
      
      // Enable and update disabled mods
      for (const mod of disabledModsToUpdate) {
        const success = await enableAndUpdateMod(
          serverPath,
          mod.modName,
          mod.projectId,
          mod.targetVersion,
          mod.targetVersionId
        );
        if (success) {
          updatedCount++;
        }
      }
      
      // Force refresh mod list and update checks to ensure UI is current
      await loadMods(serverPath);
      await checkForUpdates(serverPath, true);
      
      const enabledText = enabledModsToUpdate.length > 0 ? `${enabledModsToUpdate.length} updated` : '';
      const disabledText = disabledModsToUpdate.length > 0 ? `${disabledModsToUpdate.length} enabled and updated` : '';
      const combinedText = [enabledText, disabledText].filter(Boolean).join(', ');
      
      successMessage.set(`Successfully processed ${updatedCount} mods (${combinedText})!`);
    } catch (error) {
      errorMessage.set(`Failed to update all mods: ${error.message}`);
    } finally {
      updateAllInProgress = false;
    }
  }

  async function handleDeleteSelected() {
    if (selectedMods.size === 0) return;
    
    try {
      for (const itemName of selectedMods) {
        if ($activeContentType === CONTENT_TYPES.MODS) {
          await deleteMod(itemName, serverPath, false); // Don't reload for each item
          removeCachedVersion(itemName, CONTENT_TYPES.MODS);
        } else {
          await deleteContent(itemName, serverPath, $activeContentType, false); // Don't reload for each item
          removeCachedVersion(itemName, $activeContentType);
        }
      }
      selectedMods = new SvelteSet();
      
      // Reload once after all deletions
      if ($activeContentType === CONTENT_TYPES.MODS) {
        await loadMods(serverPath);
      } else {
        await loadContent(serverPath, $activeContentType);
      }
      
      dispatch('modRemoved');
    } catch (error) {
      const itemType = $activeContentType === CONTENT_TYPES.MODS ? 'mods' : 
                      $activeContentType === CONTENT_TYPES.SHADERS ? 'shaders' : 'resource packs';
      errorMessage.set(`Failed to delete selected ${itemType}: ${error.message}`);
    }
  }

  async function handleBulkToggle() {
    if (selectedMods.size === 0) return;
    
    // Determine what action to take based on selected mods
    const selectedModsArray = Array.from(selectedMods);
    const enabledSelected = selectedModsArray.filter(mod => !$disabledMods.has(mod));
    const disabledSelected = selectedModsArray.filter(mod => $disabledMods.has(mod));
    
    let action = '';
    let isMixedSelection = false;
    
    if (disabledSelected.length > 0 && enabledSelected.length === 0) {
      // All selected are disabled - enable them all
      action = 'enable all';
    } else if (enabledSelected.length > 0 && disabledSelected.length === 0) {
      // All selected are enabled - disable them all  
      action = 'disable all';
    } else {
      // Mixed selection - toggle each mod individually
      action = 'toggle each';
      isMixedSelection = true;
    }
    
    try {
      disabledMods.update(mods => {
        const newMods = new SvelteSet(mods);
        
        if (isMixedSelection) {
          // For mixed selections, toggle each mod individually
          for (const modName of selectedMods) {
            if (newMods.has(modName)) {
              // Mod is disabled, enable it
              newMods.delete(modName);
            } else {
              // Mod is enabled, disable it
              newMods.add(modName);
            }
          }
        } else {
          // For uniform selections, apply the same action to all
          for (const modName of selectedMods) {
            if (action === 'enable all') {
              newMods.delete(modName); // Enable (remove from disabled set)
            } else if (action === 'disable all') {
              newMods.add(modName); // Disable (add to disabled set)
            }
          }
        }
        
        return newMods;
      });
      
      await safeInvoke('save-disabled-mods', serverPath, Array.from($disabledMods));
      selectedMods = new SvelteSet();
      
      const count = selectedModsArray.length;
      let actionText;
      
      if (isMixedSelection) {
        actionText = 'toggled';
      } else if (action === 'enable all') {
        actionText = 'enabled';
      } else {
        actionText = 'disabled';
      }
      
      successMessage.set(`${count} mod${count > 1 ? 's' : ''} ${actionText} successfully.`);
      setTimeout(() => successMessage.set(''), 3000);
    } catch (error) {
      errorMessage.set(`Failed to ${action.replace(' all', '').replace(' each', '')} selected mods: ${error.message}`);
    }
  }



  async function toggleVersionSelector(modName) {
    const isExpanded = $expandedInstalledMod === modName;
    
    if (isExpanded) {
      expandedInstalledMod.set(null);
      return;
    }
    
    expandedInstalledMod.set(modName);
    
    const modInfo = currentInfoList.find(m => m.fileName === modName);
    const confirmedMatch = $confirmedModrinthMatches.get(modName);
    
    // Determine which project ID to use - prefer confirmed Modrinth match
    let projectId = null;
    if (confirmedMatch && confirmedMatch.projectId) {
      projectId = confirmedMatch.projectId;
    } else if (modInfo && modInfo.projectId) {
      projectId = modInfo.projectId;
    }
    
    if (projectId) {
      try {
        // Pass the correct content type for version fetching
        const versions = await fetchModVersions(projectId, 'modrinth', false, false, $activeContentType);
        installedModVersionsCache = { 
          ...installedModVersionsCache, 
          [projectId]: versions 
        };
      } catch (error) {
        installedModVersionsCache = { 
          ...installedModVersionsCache, 
          [projectId]: [] 
        };
      }
    } else {
      installedModVersionsCache = { 
        ...installedModVersionsCache, 
        ['no-project']: [] 
      };
    }
  }

  async function switchToVersion(modName, projectId, versionId) {
    try {
      dispatch('updateMod', { modName, projectId, versionId });
      expandedInstalledMod.set(null);
    } catch (error) {
      errorMessage.set(`Failed to switch version: ${error.message}`);
    }
  }

  function updateModToLatest(modName) {
    const updateInfo = $modsWithUpdates.get(modName);
    const modInfo = currentInfoList.find(m => m.fileName === modName);
    
    if (!updateInfo || !modInfo || !modInfo.projectId) return;
    
    dispatch('updateMod', {
      modName,
      projectId: modInfo.projectId,
      versionId: updateInfo.id
    });
  }

  function updateContentToLatest(contentName) {
    const updateInfo = $modsWithUpdates.get(contentName);
    const contentInfo = currentInfoList.find(m => m.fileName === contentName);
    
    if (!updateInfo || !contentInfo || !contentInfo.projectId) return;
    
    // Use the same event name as mods, but pass the content type
    dispatch('updateMod', {
      modName: contentName,
      projectId: contentInfo.projectId,
      versionId: updateInfo.id,
      contentType: $activeContentType
    });
  }

  async function switchToContentVersion(contentName, projectId, versionId) {
    try {
      // Use the same event name as mods, but pass the content type
      dispatch('updateMod', { 
        modName: contentName, 
        projectId, 
        versionId,
        contentType: $activeContentType
      });
      expandedInstalledMod.set(null);
    } catch (error) {
      errorMessage.set(`Failed to switch version: ${error.message}`);
    }
  }

  function showDeleteConfirmation(modName) {
    modToDelete = modName;
    confirmDeleteVisible = true;
  }

  async function confirmDeleteMod() {
    if (modToDelete) {
      let deleteSuccess;
      
      if ($activeContentType === CONTENT_TYPES.MODS) {
        const wasDisabled = $disabledMods.has(modToDelete);
        deleteSuccess = await deleteMod(modToDelete, serverPath, true);
  removeCachedVersion(modToDelete, CONTENT_TYPES.MODS);
        
        if (deleteSuccess && wasDisabled) {
          disabledMods.update(mods => {
            const newMods = new SvelteSet(mods);
            newMods.delete(modToDelete);
            return newMods;
          });
          
          await safeInvoke('save-disabled-mods', serverPath, Array.from($disabledMods));
        }
      } else {
        // For shaders and resource packs, use the generic delete function
        deleteSuccess = await deleteContent(modToDelete, serverPath, $activeContentType, true);
  removeCachedVersion(modToDelete, $activeContentType);
      }
      
      modToDelete = null;
      confirmDeleteVisible = false;
      dispatch('modRemoved');
    }
  }



  async function confirmToggleModStatus(modName, isDisabled) {
    try {
        disabledMods.update(mods => {
          const newMods = new SvelteSet(mods);
        if (isDisabled) {
          newMods.delete(modName);
      } else {
          newMods.add(modName);
        }
          return newMods;
        });
      
        await safeInvoke('save-disabled-mods', serverPath, Array.from($disabledMods));
        try { await checkDisabledModUpdates(serverPath); } catch {}
        
      const action = isDisabled ? 'enabled' : 'disabled';
      successMessage.set(`Mod ${modName} ${action} successfully.`);
        setTimeout(() => successMessage.set(''), 3000);
      } catch (error) {
        errorMessage.set(`Failed to toggle mod: ${error.message}`);
    }
  }

  async function handleEnableAndUpdate(modFileName) {
    const updatesMap = get(disabledModUpdates);
    const updateInfo = findDisabledUpdate(updatesMap, modFileName);

    if (!updateInfo) {
      errorMessage.set('No update information available for this mod');
      return;
    }

    const updateKey = updateInfo.fileName || normalizeFileName(modFileName);

    try {
      const success = await enableAndUpdateMod(
        serverPath,
        updateKey || modFileName,
        updateInfo.projectId,
        updateInfo.latestVersion,
        updateInfo.latestVersionId
      );

      if (success) {
        await loadMods(serverPath);
      }
    } catch (error) {
      errorMessage.set(`Failed to enable and update mod: ${error.message}`);
    }
  }

  async function handleDependencyDownload(dependency) {
    if (!dependency.projectId) {
      errorMessage.set('Cannot download dependency: missing project information');
      return;
    }

    try {
      successMessage.set(`Downloading dependency: ${dependency.name}...`);
      
      // Create a mod object for the dependency
      const dependencyMod = {
        id: dependency.projectId,
        name: dependency.name,
        title: dependency.name,
        source: 'modrinth'
      };

      // Try to determine the actual content type of the dependency
      let dependencyContentType = $activeContentType; // Default to parent type
      
      // Use name-based heuristics to determine content type
      const dependencyName = (dependency.name || '').toLowerCase();
      
      // Check for common shader keywords
      if (dependencyName.includes('shader') || 
          dependencyName.includes('iris') || 
          dependencyName.includes('optifine') ||
          dependencyName.includes('complementary') ||
          dependencyName.includes('bsl') ||
          dependencyName.includes('seus')) {
        dependencyContentType = 'shaders';
      }
      // Check for common resource pack keywords
      else if (
        // Narrowed: require explicit resource-pack style indicators and absence of clear mod signals
        (/resource\s?pack/.test(dependencyName) || dependencyName.endsWith('pack') || dependencyName.includes('textures.zip')) &&
        !/fabric|forge|neoforge|quilt|api|core|library/.test(dependencyName)
      ) {
        dependencyContentType = 'resourcepacks';
      }
      // Otherwise, assume it's a mod
      else {
        dependencyContentType = 'mods';
      }
      


      // Determine the best version to install based on version requirement
      let versionId = null;
    if (dependency.versionRequirement) {
        try {
          // Try to get versions and find the best match
          const loader = get(loaderType);
          const mcVersion = get(minecraftVersion);
          if (!mcVersion) {
            // Log via IPC logger utility if available
            try { await safeInvoke('log-message', { level: 'warn', category: 'mods', message: 'Dependency version fetch without mcVersion', data: { projectId: dependency.projectId }}); } catch {}
          }
      try { await safeInvoke('logger-allow-burst', 15000); } catch {}
          const versions = await safeInvoke('get-mod-versions', {
            modId: dependency.projectId,
            source: 'modrinth',
            loader,
            mcVersion
          });
          
          if (versions && versions.length > 0) {
            // Sort versions by date (newest first)
            const sortedVersions = [...versions].sort((a, b) => {
              const dateA = a.datePublished ? new Date(a.datePublished).getTime() : 0;
              const dateB = b.datePublished ? new Date(b.datePublished).getTime() : 0;
              return dateB - dateA;
            });
            
            // Find the best version that matches the requirement
            for (const version of sortedVersions) {
              if (checkVersionCompatibility(version.versionNumber, dependency.versionRequirement)) {
                versionId = version.id;
                break;
              }
            }
            
            // If no specific version matches, use the latest
            if (!versionId && sortedVersions.length > 0) {
              versionId = sortedVersions[0].id;
            }
          }
        } catch (versionError) {
          // If version resolution fails, let the system choose
        }
      }

      // Dispatch install event to parent component (ServerModManager)
      dispatch('install', { 
        mod: dependencyMod, 
        versionId: versionId,
        isDependency: true, // Flag to indicate this is a dependency installation
        contentType: dependencyContentType, // Pass the determined content type for dependencies
        onSuccess: async () => {
          // Refresh compatibility check after successful installation
          await refreshCompatibilityAfterInstall();
          successMessage.set(`Successfully installed dependency: ${dependency.name}`);
        },
        onError: (error) => {
          errorMessage.set(`Failed to install dependency ${dependency.name}: ${error.message || error}`);
        }
      });

    } catch (error) {
      errorMessage.set(`Failed to download dependency: ${error.message}`);
    }
  }

  async function refreshCompatibilityAfterInstall() {
    try {
      // Reload mods to get updated installed mod info
      await loadMods(serverPath);
      
      // Re-run compatibility check if results are currently displayed
      if (compatibilityResults) {
        await checkAllModsCompatibility();
      }
    } catch (error) {
      // Failed to refresh compatibility after dependency install
    }
  }

  async function handleBulkDependencyDownload(missingDependencies) {
    if (bulkDownloadInProgress || missingDependencies.length === 0) {
      return;
    }

    bulkDownloadInProgress = true;
    bulkDownloadProgress = 0;
    
    const totalDependencies = missingDependencies.length;
    const successfulInstalls = [];
    const failedInstalls = [];
    
    try {
      successMessage.set(`Starting bulk download of ${totalDependencies} dependencies...`);
      
      // Create a unique list of dependencies to avoid duplicates
      const uniqueDependencies = [];
      const seenProjectIds = new SvelteSet();
      
      for (const issue of missingDependencies) {
        const projectId = issue.dependency?.projectId;
        if (projectId && !seenProjectIds.has(projectId)) {
          seenProjectIds.add(projectId);
          uniqueDependencies.push(issue.dependency);
        }
      }
      
      // Download dependencies one by one to avoid overwhelming the system
      for (let i = 0; i < uniqueDependencies.length; i++) {
        const dependency = uniqueDependencies[i];
        bulkDownloadProgress = i;
        
        try {
          successMessage.set(`Installing dependency ${i + 1}/${uniqueDependencies.length}: ${dependency.name}...`);
          
          // Create a mod object for the dependency
          const dependencyMod = {
            id: dependency.projectId,
            name: dependency.name,
            title: dependency.name,
            source: 'modrinth'
          };

          // Try to determine the actual content type of the dependency
          let dependencyContentType = $activeContentType; // Default to parent type
          
          // Use name-based heuristics to determine content type
          const dependencyName = (dependency.name || '').toLowerCase();
          
          // Check for common shader keywords
          if (dependencyName.includes('shader') || 
              dependencyName.includes('iris') || 
              dependencyName.includes('optifine') ||
              dependencyName.includes('complementary') ||
              dependencyName.includes('bsl') ||
              dependencyName.includes('seus')) {
            dependencyContentType = 'shaders';
          }
          // Check for common resource pack keywords
          else if ((/resource\s?pack/.test(dependencyName) || dependencyName.endsWith('pack') || dependencyName.includes('textures.zip')) && !/fabric|forge|neoforge|quilt|api|core|library/.test(dependencyName)) {
            dependencyContentType = 'resourcepacks';
          }
          // Otherwise, assume it's a mod
          else {
            dependencyContentType = 'mods';
          }
          


          // Determine the best version to install
          let versionId = null;
      if (dependency.versionRequirement) {
            try {
              const loader = get(loaderType);
              const mcVersion = get(minecraftVersion);
              if (!mcVersion) {
                try { await safeInvoke('log-message', { level: 'warn', category: 'mods', message: 'Bulk dependency version fetch without mcVersion', data: { projectId: dependency.projectId }}); } catch {}
              }
        try { await safeInvoke('logger-allow-burst', 15000); } catch {}
              const versions = await safeInvoke('get-mod-versions', {
                modId: dependency.projectId,
                source: 'modrinth',
                loader,
                mcVersion
              });
              
              if (versions && versions.length > 0) {
                const sortedVersions = [...versions].sort((a, b) => {
                  const dateA = a.datePublished ? new Date(a.datePublished).getTime() : 0;
                  const dateB = b.datePublished ? new Date(b.datePublished).getTime() : 0;
                  return dateB - dateA;
                });
                
                for (const version of sortedVersions) {
                  if (checkVersionCompatibility(version.versionNumber, dependency.versionRequirement)) {
                    versionId = version.id;
                    break;
                  }
                }
                
                if (!versionId && sortedVersions.length > 0) {
                  versionId = sortedVersions[0].id;
                }
              }
            } catch (versionError) {
              // Failed to resolve dependency version
            }
          }

          // Install the dependency using a Promise to handle the callback-based system
          await new Promise((resolve, reject) => {
            dispatch('install', { 
              mod: dependencyMod, 
              versionId: versionId,
              isDependency: true,
              contentType: dependencyContentType, // Pass the determined content type for dependencies
              onSuccess: async () => {
                successfulInstalls.push(dependency.name);
                resolve();
              },
              onError: (error) => {
                failedInstalls.push({ name: dependency.name, error: error.message || error });
                reject(error);
              }
            });
          });
          
        } catch (error) {
          // Failed to install dependency
          failedInstalls.push({ name: dependency.name, error: error.message || error });
        }
      }
      
      bulkDownloadProgress = uniqueDependencies.length;
      
      // Show final results
      if (failedInstalls.length === 0) {
        successMessage.set(`Successfully installed all ${successfulInstalls.length} dependencies!`);
      } else if (successfulInstalls.length === 0) {
        errorMessage.set(`Failed to install all dependencies. ${failedInstalls.length} failed.`);
      } else {
        successMessage.set(`Partially successful: ${successfulInstalls.length} installed, ${failedInstalls.length} failed.`);
        
        // Show details of failed installations
        const failedNames = failedInstalls.map(f => f.name).join(', ');
        setTimeout(() => {
          errorMessage.set(`Failed dependencies: ${failedNames}`);
        }, 3000);
      }
      
      // Refresh compatibility check after bulk installation
      await refreshCompatibilityAfterInstall();
      
    } catch (error) {
      errorMessage.set(`Bulk dependency download failed: ${error.message || error}`);
    } finally {
      bulkDownloadInProgress = false;
      bulkDownloadProgress = 0;
    }
  }

  async function handleCategoryChange(modName, event) {
    try {
      const newCategory = event.target.value;
      await updateModCategory(modName, newCategory);
      
      const result = await safeInvoke('move-mod-file', {
        fileName: modName, 
        newCategory,
        serverPath
      });
      
      if (result && result.success) {
        successMessage.set(`Changed ${modName} to "${newCategory}"`);
        setTimeout(() => successMessage.set(''), 3000);
      } else {
        throw new Error(result?.error || 'Unknown error occurred');
      }
      
      await loadMods(serverPath);
    } catch (err) {
      errorMessage.set(`Failed to update mod category: ${err.message}`);
    }
  }

  async function handleRequirementChange(modName, event) {
    try {
      const required = event.target.checked;
      await updateModRequired(modName, required);
      successMessage.set(`${modName} is now ${required ? 'required' : 'optional'} for clients`);
      setTimeout(() => successMessage.set(''), 3000);
    } catch (err) {
      errorMessage.set(`Failed to update mod requirement: ${err.message}`);
    }
  }

  // Simple keyboard shortcut for search focus
  function handleGlobalKeyDown(event) {
    if (event.key === '/' && event.target.tagName !== 'INPUT' && event.target.tagName !== 'TEXTAREA') {
      event.preventDefault();
      const searchInput = document.querySelector('.search-input');
      if (searchInput instanceof HTMLInputElement) {
        searchInput.focus();
      }
    }
  }

  onMount(() => {
    // Add global keyboard listener for search shortcut
    document.addEventListener('keydown', handleGlobalKeyDown);
    
    // Load mod categories and disabled mods from storage on startup
    const initAsync = async () => {
    try {
      await loadModCategories();
      
      // Load disabled mods from storage
      if (serverPath) {
        try {
          const disabledModsList = await safeInvoke('get-disabled-mods', serverPath);
          if (Array.isArray(disabledModsList)) {
            disabledMods.set(new SvelteSet(disabledModsList));
            try { await checkDisabledModUpdates(serverPath); } catch {}
          }
        } catch (error) {
        }

        // Load Modrinth matching data
        try {
          await modrinthMatchingActions.loadPendingConfirmations();
          await modrinthMatchingActions.loadConfirmedMatches();
        } catch (error) {
        }

        // Ensure mod info is loaded for the current content type
        // This helps fix the initial "No version info" display issue
        
        // Try multiple times with increasing delays to ensure version info is loaded
        const attemptVersionLoad = async (attempt = 1, maxAttempts = 3) => {
          if (versionLoadAttempted) return;
          
          const currentInfo = getCurrentInfoStore();
          const currentItems = $activeContentType === CONTENT_TYPES.SHADERS ? $installedShaders :
                              $activeContentType === CONTENT_TYPES.RESOURCE_PACKS ? $installedResourcePacks :
                              $installedMods;
          

          
          if (currentItems.length > 0 && (currentInfo.length === 0 || currentInfo.every(info => !info || !info.versionNumber))) {
            versionLoadAttempted = true;
            try {
              loadingVersionInfo = true;
              updateLoadingGrace();
              const currentContentType = get(activeContentType);
              if (currentContentType === CONTENT_TYPES.MODS) {
                await loadMods(serverPath);
              } else {
                await loadContent(serverPath, currentContentType);
              }
              
              // Check if we got version info, if not and we have more attempts, try again
              const updatedInfo = getCurrentInfoStore();
              if (attempt < maxAttempts && updatedInfo.every(info => !info || !info.versionNumber)) {
                versionLoadAttempted = false; // Reset for next attempt
                setTimeout(() => attemptVersionLoad(attempt + 1, maxAttempts), 500 * attempt);
              } else {
                // Reset after successful load or max attempts
                setTimeout(() => {
                  versionLoadAttempted = false;
                }, 2000);
              }
            } catch (error) {
              // Version load attempt failed
              versionLoadAttempted = false;
              if (attempt < maxAttempts) {
                setTimeout(() => attemptVersionLoad(attempt + 1, maxAttempts), 500 * attempt);
              }
            } finally {
              loadingVersionInfo = false;
              updateLoadingGrace();
            }
          }
        };
        
        // Start the first attempt after a small delay
        setTimeout(() => attemptVersionLoad(), 200);
        
        // Set up content type change monitoring
        const checkContentTypeChange = () => {
          if ($activeContentType !== lastActiveContentType) {
            lastActiveContentType = $activeContentType;
            versionLoadAttempted = false;
            loadingVersionInfo = false;
            updateLoadingGrace();
            // Check version info after a small delay to allow stores to update
            setTimeout(() => checkAndLoadVersionInfo($activeContentType, serverPath), 100);
          }
        };
        
        // Check for content type changes periodically
        const contentTypeInterval = setInterval(checkContentTypeChange, 300);
        
        // Clean up interval on component destroy
        return () => {
          clearInterval(contentTypeInterval);
        };
      }
    } catch (error) {
    }
    };
    
    // Start async initialization
    initAsync();
    // Return cleanup function
    return () => {
      document.removeEventListener('keydown', handleGlobalKeyDown);
    };
  });
</script>

<!-- Header actions -->
<div class="mods-header">
  <div class="left">
    <!-- Unified toolbar -->
    <div class="mods-toolbar">
      <button class="icon-btn" on:click={handleCheckUpdates} disabled={$isCheckingUpdates} title={$isCheckingUpdates ? 'Checking...' : 'Check for Updates'}>
        🔄
      </button>
      <!-- Only show compatibility check for mods -->
      {#if $activeContentType === CONTENT_TYPES.MODS}
        <button class="icon-btn" on:click={checkAllModsCompatibility} disabled={checkingCompatibility} title={checkingCompatibility ? 'Checking compatibility...' : 'Check Compatibility'}>
          {#if checkingCompatibility}⏳{:else}✅{/if}
        </button>
      {/if}
      
      <!-- Search box -->
      <div class="search-container">
        <input 
          type="text" 
          class="search-input" 
          placeholder="Search {$activeContentType === CONTENT_TYPES.SHADERS ? 'shaders' : $activeContentType === CONTENT_TYPES.RESOURCE_PACKS ? 'resource packs' : 'mods'} ( / )"
          bind:value={searchTerm}
        />
        {#if searchTerm}
          <button class="search-clear" on:click={() => searchTerm = ''} title="Clear search">×</button>
        {/if}
      </div>
      
      <!-- Add content button -->
      <button class="add-mods-btn-outline" 
              class:drag-highlight={isDragover}
              on:click={toggleDropZone} 
              on:dragenter={handleAddButtonDragEnter}
              on:dragover={handleDragOver}
              on:dragleave={handleDragLeave}
              on:drop={handleDrop}
              title="Add {$activeContentType === CONTENT_TYPES.SHADERS ? 'shaders' : $activeContentType === CONTENT_TYPES.RESOURCE_PACKS ? 'resource packs' : 'mods'} by dragging files or clicking to browse">
        📦 Add {$activeContentType === CONTENT_TYPES.SHADERS ? 'Shaders' : $activeContentType === CONTENT_TYPES.RESOURCE_PACKS ? 'Resource Packs' : 'Mods'}
      </button>
      
      <!-- Search hint -->
      <div class="keyboard-hint" title="Use Tab to navigate between controls, / to focus search">
        ⌨️
      </div>
    </div>
  </div>

  {#if updateCount > 0}
    <button class="primary sm" on:click={updateAllMods} disabled={updateAllInProgress || serverRunning} title="Update all outdated mods">
      {#if serverRunning}🔒{/if} ⬆️ {updateAllInProgress ? 'Updating...' : `Update All (${updateCount})`}
    </button>
  {/if}

  {#if selectedMods.size > 0}
    {@const selectedModsArray = Array.from(selectedMods)}
    {@const enabledSelected = selectedModsArray.filter(mod => !$disabledMods.has(mod))}
    {@const disabledSelected = selectedModsArray.filter(mod => $disabledMods.has(mod))}
    {@const buttonText = disabledSelected.length > 0 && enabledSelected.length === 0 ? 'Enable' : 
                        enabledSelected.length > 0 && disabledSelected.length === 0 ? 'Disable' : 
                        'Toggle'}
    {@const buttonClass = disabledSelected.length > 0 && enabledSelected.length === 0 ? 'primary' : 
                          enabledSelected.length > 0 && disabledSelected.length === 0 ? 'warn' :
                          'primary'}
    <div class="bulk">
      <button class="danger sm" on:click={handleDeleteSelected} disabled={serverRunning}>
        {#if serverRunning}🔒{/if} 🗑 Delete Selected ({selectedMods.size})
      </button>
      <!-- Only show disable/enable for mods, not for shaders or resource packs -->
      {#if $activeContentType === CONTENT_TYPES.MODS}
        <button class="{buttonClass} sm" on:click={handleBulkToggle} disabled={serverRunning}>
          {#if serverRunning}🔒{/if} 
          {buttonText === 'Enable' ? '✅' : buttonText === 'Disable' ? '🚫' : '⚡'} 
          {buttonText} Selected ({selectedMods.size})
        </button>
      {/if}
    </div>
  {/if}
</div>

<!-- Compatibility Results Display -->
{#if compatibilityResults}
  <div class="compatibility-results">
    <div class="results-header">
      <h4>🔍 Compatibility Check Results</h4>
      <button class="close-results" on:click={() => compatibilityResults = null} title="Close results">×</button>
    </div>
    
    <div class="results-summary">
      <span class="summary-stat">
        <strong>{compatibilityResults.totalChecked}</strong> mods checked
      </span>
      <span class="summary-stat">
        <strong>{compatibilityResults.totalIssues}</strong> issues found
      </span>
      <span class="summary-stat">
        <strong>{compatibilityResults.modsWithIssues}</strong> mods affected
      </span>
    </div>
    
    {#if compatibilityResults.issues.length > 0}
      {@const allMissingDependencies = compatibilityResults.issues.flatMap(modIssue => 
        modIssue.issues.filter(issue => issue.type === 'missing' && issue.dependency?.projectId)
      )}
      
      {@const groupedDependencies = (() => {
        const groups = new SvelteMap();
        
        // Group all issues by dependency
        for (const modIssue of compatibilityResults.issues) {
          for (const issue of modIssue.issues) {
            if (issue.dependency?.projectId) {
              const depId = issue.dependency.projectId;
              if (!groups.has(depId)) {
                groups.set(depId, {
                  dependency: issue.dependency,
                  type: issue.type,
                  versionInfo: issue.versionInfo,
                  message: issue.message,
                  affectedMods: []
                });
              }
              groups.get(depId).affectedMods.push({
                modName: modIssue.modName,
                mod: modIssue.mod
              });
            }
          }
        }
        
        return Array.from(groups.values());
      })()}
      
      {@const uniqueMissingDependencies = groupedDependencies.filter(group => group.type === 'missing')}
      
      {#if uniqueMissingDependencies.length > 1}
        <div class="bulk-download-section">
          <button 
            class="bulk-download-btn"
            on:click={() => handleBulkDependencyDownload(allMissingDependencies)}
            disabled={serverRunning || bulkDownloadInProgress}
            title={serverRunning ? 'Server must be stopped to install dependencies' : `Download all ${uniqueMissingDependencies.length} missing dependencies`}
          >
            {#if serverRunning}🔒{:else if bulkDownloadInProgress}⏳{:else}📦{/if} 
            {bulkDownloadInProgress ? `Downloading... (${bulkDownloadProgress}/${uniqueMissingDependencies.length})` : `Download All Dependencies (${uniqueMissingDependencies.length})`}
          </button>
        </div>
      {/if}
      
      <div class="issues-list">
        {#each groupedDependencies as dependencyGroup (dependencyGroup.dependency.projectId)}
          <div class="dependency-group dependency-{dependencyGroup.type}">
            <div class="dependency-header">
              <span class="dependency-type">
                {#if dependencyGroup.type === 'missing'}
                  ❌ Missing Dependency
                {:else if dependencyGroup.type === 'disabled'}
                  ⚠️ Disabled Dependency
                {:else if dependencyGroup.type === 'version_mismatch'}
                  🔄 Version Mismatch
                {:else if dependencyGroup.type === 'update_available'}
                  ⬆️ Update Available
                {:else}
                  ℹ️ {dependencyGroup.type}
                {/if}
              </span>
              <strong class="dependency-name">{dependencyGroup.dependency.name || 'Unknown'}</strong>
              {#if dependencyGroup.versionInfo}
                <span class="version-info">({dependencyGroup.versionInfo})</span>
              {/if}
              {#if dependencyGroup.type === 'missing' && dependencyGroup.dependency.projectId}
                <button 
                  class="dependency-download-btn"
                  on:click={() => handleDependencyDownload(dependencyGroup.dependency)}
                  disabled={serverRunning}
                  title={serverRunning ? 'Server must be stopped to install dependencies' : `Download ${dependencyGroup.dependency.name}`}
                >
                  {#if serverRunning}🔒{/if} Download
                </button>
              {/if}
            </div>
            <div class="affected-mods">
              <span class="affected-label">Required by:</span>
              <span class="affected-list">
                {dependencyGroup.affectedMods.map(mod => mod.modName).join(', ')}
              </span>
            </div>
            <div class="dependency-message">
              {dependencyGroup.message}
            </div>
          </div>
        {/each}
      </div>
    {:else}
      <div class="no-issues">
        <p>✅ All checked mods are compatible with no dependency issues!</p>
      </div>
    {/if}
  </div>
{/if}

<!-- Optional expanded drop zone (only shown when button is clicked) -->
{#if !dropZoneCollapsed}
<div class="drop-zone-container">
    <div class="drop-zone-full" 
         class:drag-highlight={isDragover}
         on:dragenter={handleAddButtonDragEnter}
         on:dragover={handleDragOver}
         on:dragleave={handleDragLeave}
         on:drop={handleDrop}
         role="button"
         tabindex="0"
         aria-label="Drop zone for mod files"
         transition:fly="{{ y: -20, duration: 300 }}">
      <div class="drop-zone-content">
        <div class="drop-icon">📦</div>
        <p>Drag and drop .jar files here</p>
        <p class="drop-or">or</p>
        <button class="browse-btn" on:click={handleBrowseFiles}>Browse Files</button>
      </div>
      <button class="collapse-btn" on:click={toggleDropZone} title="Collapse drop zone">−</button>
    </div>
</div>
{/if}

<!-- Content table -->
<div class="table-container">
{#if $activeContentType === CONTENT_TYPES.MODS}
  <!-- Mods table with full functionality -->
  <table class="mods-table">
    <thead>
      <tr>
        <th class="chk sel-all" title="Select all" on:click={toggleSelectAll}>
          {#if selectedMods.size === filteredMods.length && selectedMods.size > 0}
            ■
          {:else if selectedMods.size > 0}
            ◩
          {:else}
            ▢
          {/if}
          <input type="checkbox"
                 checked={selectedMods.size === filteredMods.length}
                 indeterminate={selectedMods.size && selectedMods.size !== filteredMods.length}
                 on:change={toggleSelectAll}
                 style="opacity: 0; position: absolute; pointer-events: none;">
        </th>
        <th>Mod Name</th>
        <th class="loc">Location</th>
        <th class="ver">Current</th>
        <th class="alert">⚠️</th>
        <th class="status">Status</th>
        <th class="upd">Update</th>
        <th class="act">Actions</th>
      </tr>
    </thead>

  <tbody>
    {#if filteredMods.length === 0 && searchTerm}
      <tr>
        <td colspan="8" class="no-results">
          No mods found matching "{searchTerm}"
        </td>
      </tr>
    {:else}
      {#each filteredMods as mod (mod)}
      {@const modInfo = currentInfoList.find(m => m && m.fileName === mod)}
              {@const modCategoryInfo = $categorizedModsStore.find(m => m.fileName === mod)}
      {@const location = modCategoryInfo?.category || 'server-only'}
        {@const isDisabled = $disabledMods.has(mod)}
        {@const borderColor = locColor[location] || '#2c82ff'}
        
        <tr class:selected={selectedMods.has(mod)} 
            class:disabled={isDisabled}
            style="border-left-color:{borderColor}; border-left-width: 4px; border-left-style: solid;">
        <!-- checkbox -->
        <td>
          <input type="checkbox"
                 checked={selectedMods.has(mod)}
                 on:change={() => toggleSelect(mod)} />
        </td>

        <!-- name + MC version tag -->
        <td>
          {#each [mod] as modKey (modKey)}
            {@const confirmedMatch = $confirmedModrinthMatches.get(mod)}
            <strong>
              {#if confirmedMatch}
                {confirmedMatch.modrinthData.title}
              {:else}
                {modCategoryInfo?.name || mod}
              {/if}
            </strong>
          {/each}
          {#if modInfo && modInfo.mcVersion}
            <span class="mc-tag">MC {modInfo.mcVersion}</span>
          {/if}
        </td>

        <!-- location selector -->
        <td>
          <select
            class="loc-select"
              disabled={serverRunning || isDisabled}
            value={location}
            on:change={(e) => handleCategoryChange(mod, e)}>
            <option value="server-only">Server Only</option>
            <option value="client-only">Client Only</option>
            <option value="both">Client & Server</option>
          </select>
          {#if (location === 'client-only' || location === 'both')}
            <label class="req">
              <input type="checkbox"
                       disabled={serverRunning || isDisabled}
                     checked={modCategoryInfo?.required}
                     on:change={(e) => handleRequirementChange(mod, e)} />
              required
            </label>
          {/if}
        </td>

        <!-- current version -->
        <td class="ver">
          {#each [mod] as modKey (modKey)}
            {@const confirmedMatch = $confirmedModrinthMatches.get(mod)}
            
            {#if confirmedMatch}
              <!-- Show just the version like other mods -->
              {#if confirmedMatch.modrinthData.selectedVersion}
                <code title="Modrinth version: {confirmedMatch.modrinthData.selectedVersion.versionNumber || confirmedMatch.modrinthData.selectedVersion.version_number}">
                  {confirmedMatch.modrinthData.selectedVersion.versionNumber || confirmedMatch.modrinthData.selectedVersion.version_number}
                </code>
                <button 
                  class="reset-match-btn" 
                  title="Reset Modrinth match and search again"
                  on:click={() => resetModMatch(mod)}
                >
                  🔄
                </button>
              {:else if modInfo && modInfo.versionNumber}
                <code title={generateVersionTooltip(modInfo)}>{modInfo.versionNumber}</code>
                <button 
                  class="reset-match-btn" 
                  title="Reset Modrinth match and search again"
                  on:click={() => resetModMatch(mod)}
                >
                  🔄
                </button>
              {:else}
                {@const cached = getCachedVersion(mod)}
                {#if cached}
                  <code title="Cached version (refreshing in background)">{cached}</code>
                {:else if showLoadingIndicator}
                  <span class="loading">Loading...</span>
                {:else if $isLoading || loadingVersionInfo}
                  <span class="loading" style="visibility:hidden;">Loading...</span>
                {:else}
                  {#if !initialUiSuppression}
                    <div class="no-version-info">
                      <span>No version info</span>
                      <button 
                        class="reset-match-btn" 
                        title="Reset Modrinth match and search again"
                        on:click={() => resetModMatch(mod)}
                      >
                        🔄
                      </button>
                    </div>
                  {/if}
                {/if}
              {/if}
            {:else if modInfo && modInfo.versionNumber}
              <!-- Show basic version info when no confirmed match but mod has version info -->
              <code title={generateVersionTooltip(modInfo)}>{modInfo.versionNumber}</code>
            {:else}
              <!-- No version info and no confirmed match - check if we're loading -->
              {@const cached = getCachedVersion(mod)}
              {#if cached}
                <code title="Cached version (refreshing in background)">{cached}</code>
              {:else if showLoadingIndicator}
                <span class="loading">Loading...</span>
              {:else if $isLoading || loadingVersionInfo}
                <span class="loading" style="visibility:hidden;">Loading...</span>
              {:else}
                {#if !initialUiSuppression}
                  <div class="no-version-info">
                    <span>No version info</span>
                  </div>
                {/if}
              {/if}
              
              <!-- Modrinth matching UI for unmatched mods without version info -->
              {#if !suppressMatchingUi && !initialUiSuppression && !getCachedVersion(mod)}
                <ModrinthMatchConfirmation 
                  fileName={mod}
                  on:matchConfirmed={handleMatchConfirmed}
                  on:matchRejected={handleMatchRejected}
                  on:triggerAutoSearch={handleTriggerAutoSearch}
                  on:triggerManualSearch={handleTriggerManualSearch}
                />
              {/if}
            {/if}
          {/each}
        </td>

          <!-- warning/error column -->
          <td class="alert">
            {#if hasCompatibilityIssues(mod)}
              <span class="warn-badge" title="Compatibility issues detected">⚠️</span>
            {/if}
          </td>

          <!-- status column -->
          <td class="status">
            {#if isDisabled}
              <span class="status-badge disabled">Disabled</span>
            {:else}
              <span class="status-badge enabled">Enabled</span>
            {/if}
          </td>

        <!-- update badge / selector trigger -->
        <td class="upd">
          {#if isDisabled}
            {@const disabledUpdateInfo = findDisabledUpdate($disabledModUpdates, mod)}
            {#if disabledUpdateInfo}
              <div class="update-actions compact">
                <button class="tag new clickable upd-btn"
                        disabled={serverRunning}
                        on:click={() => handleEnableAndUpdate(mod)}
                        title={serverRunning ? 'Server must be stopped to enable and update mods' : `Enable and update to ${disabledUpdateInfo.latestVersion}`}>
                  {#if serverRunning}🔒{/if} ↑ <span class="ver-label">{disabledUpdateInfo.latestVersion}</span>
                </button>
                <button class="ghost sm ignore-btn"
                        disabled={serverRunning}
                        aria-label="Ignore this version"
                        title="Ignore this version (won't show until a newer one exists)"
                        on:click={() => {
                          const ui = disabledUpdateInfo;
                          if (!ui) return;
                          const updateKey = ui.fileName || normalizeFileName(mod);
                          disabledModUpdates.update(m => {
                            const nm = new SvelteMap(m);
                            if (updateKey) nm.delete(updateKey);
                            if (updateKey && updateKey !== mod) nm.delete(mod);
                            return nm;
                          });
                          ignoreUpdate(updateKey || mod, ui.latestVersionId, ui.latestVersion);
                        }}>
                  ✖
                </button>
              </div>
            {:else}
              <span class="tag ok" title="Enable to check for updates">—</span>
            {/if}
          {:else if $modsWithUpdates.has(mod)}
            {@const updateInfo = $modsWithUpdates.get(mod)}
            <div class="update-actions compact">
              <button class="tag new clickable upd-btn"
                      disabled={serverRunning}
                      on:click={() => updateModToLatest(mod)}
                      title={serverRunning ? 'Server must be stopped to update mods' : `Update to ${updateInfo.versionNumber}`}>
                {#if serverRunning}🔒{/if} ↑ <span class="ver-label">{updateInfo.versionNumber}</span>
              </button>
              <button class="ghost sm ignore-btn"
                      disabled={serverRunning}
                      aria-label="Ignore this version"
                      title="Ignore this version (won't show until a newer one exists)"
                      on:click={() => {
                        const ui = updateInfo;
                        if (!ui) return;
                        modsWithUpdates.update(m => {
                          const nm = new SvelteMap(m);
                          nm.delete(mod);
                          try {
                            const info = $installedModInfo.find(i => i.fileName === mod);
                            if (info && info.projectId) nm.delete(`project:${info.projectId}`);
                          } catch {}
                          return nm;
                        });
                        ignoreUpdate(mod, ui.id, ui.versionNumber || ui.version_number || ui.name);
                      }}>
                ✖
              </button>
            </div>
          {:else}
            <span class="tag ok" title={isDisabled ? 'Mod is disabled' : 'Up to date'}>{isDisabled ? '—' : 'Up to date'}</span>
          {/if}
        </td>

        <!-- action buttons -->
        <td class="act">
          <button class="danger sm"
                  disabled={serverRunning}
                  title={serverRunning ? 'Stop the server to delete mods' : 'Delete mod'}
                  on:click={() => showDeleteConfirmation(mod)}>
            {#if serverRunning}🔒{/if} 🗑
          </button>

            {#if isDisabled}
              <button class="primary sm"
                      disabled={serverRunning}
                      title={serverRunning ? 'Stop the server to enable mods' : 'Enable mod'}
                      on:click={() => confirmToggleModStatus(mod, true)}>
                {#if serverRunning}🔒{/if} Enable
              </button>
            {:else}
          <button class="warn sm"
                  disabled={serverRunning}
                  title={serverRunning ? 'Stop the server to disable mods' : 'Disable mod'}
                      on:click={() => confirmToggleModStatus(mod, false)}>
                {#if serverRunning}🔒{/if} Disable
          </button>
              
              <button class="ghost sm" 
                      title="Change version" 
                      disabled={serverRunning}
                      on:click={() => toggleVersionSelector(mod)}>
                {#if serverRunning}🔒{/if} {$expandedInstalledMod === mod ? '▲' : '▼'}
              </button>
            {/if}
        </td>
      </tr>

        {#if !isDisabled && $expandedInstalledMod === mod}
          {@const confirmedMatch = $confirmedModrinthMatches.get(mod)}
          {@const projectId = confirmedMatch?.projectId || modInfo?.projectId}
          
        <tr transition:fly="{{ x: 10, duration: 100 }}">
            <td colspan="8">
            <div class="versions">
              {#if !projectId}
                <span class="err">No project information available</span>
              {:else if !installedModVersionsCache[projectId]}
                <span class="loading">Loading versions...</span>
              {:else if installedModVersionsCache[projectId]?.length === 0}
                <span class="err">No versions available</span>
              {:else}
                {#each installedModVersionsCache[projectId] || [] as version (version.id)}
                  {@const isCurrentVersion = modInfo && modInfo.versionId === version.id}
                  <button
                    class:sel={isCurrentVersion}
                    disabled={isCurrentVersion}
                    on:click={() => switchToVersion(mod, projectId, version.id)}>
                    {version.versionNumber || version.name}
                    {#if isCurrentVersion} (current){/if}
                  </button>
                {/each}
              {/if}
            </div>
          </td>
        </tr>
      {/if}
    {/each}
      {/if}
    </tbody>
  </table>
{:else}
  <!-- Enhanced table for shaders and resource packs -->
  <table class="mods-table">
    <thead>
      <tr>
        <th class="chk sel-all" title="Select all" on:click={toggleSelectAll}>
          {#if selectedMods.size === filteredMods.length && selectedMods.size > 0}
            ■
          {:else if selectedMods.size > 0}
            ◩
          {:else}
            ▢
          {/if}
          <input type="checkbox"
                 checked={selectedMods.size === filteredMods.length}
                 indeterminate={selectedMods.size && selectedMods.size !== filteredMods.length}
                 on:change={toggleSelectAll}
                 style="opacity: 0; position: absolute; pointer-events: none;">
        </th>
        <th>{$activeContentType === CONTENT_TYPES.SHADERS ? 'Shader' : 'Resource Pack'} Name</th>
        <th class="loc">Location</th>
        <th class="ver">Current</th>
        <th class="upd">Update</th>
        <th class="act">Actions</th>
      </tr>
    </thead>

    <tbody>
      {#if filteredMods.length === 0 && searchTerm}
        <tr>
          <td colspan="6" class="no-results">
            No {$activeContentType === CONTENT_TYPES.SHADERS ? 'shaders' : 'resource packs'} found matching "{searchTerm}"
          </td>
        </tr>
      {:else}
        {#each filteredMods as item (item)}
          {@const info = currentInfoList.find(i => i.fileName === item)}
          <tr class:selected={selectedMods.has(item)}>
            <!-- checkbox -->
            <td>
              <input type="checkbox"
                     checked={selectedMods.has(item)}
                     on:change={() => toggleSelect(item)} />
            </td>

            <!-- name -->
            <td>
              <strong>{item.replace(/\.(zip|jar)$/i, '')}</strong>
            </td>

            <!-- location (read-only for now) -->
            <td class="loc">
              <span class="tag ok">Client Only</span>
            </td>

            <!-- current version -->
            <td class="ver">
              {#if info && info.versionNumber && info.versionNumber !== 'Unknown'}
                <code title={generateVersionTooltip(info)}>{info.versionNumber}</code>
              {:else if info && info.versionNumber === 'Unknown'}
                <span class="no-versions" title="Version information not available in file">Unknown</span>
              {:else}
                {#if showLoadingIndicator}
                  <span class="loading">Loading...</span>
                {:else if $isLoading || loadingVersionInfo}
                  <span class="loading" style="visibility:hidden;">Loading...</span>
                {:else}
                  <span class="no-versions">No version info</span>
                {/if}
              {/if}
            </td>

            <!-- update column -->
            <td class="upd">
              {#if $modsWithUpdates.has(item)}
        {@const updateInfo = $modsWithUpdates.get(item)}
                <div class="update-actions compact">
                  <button class="tag new clickable upd-btn" 
            title={`Update to ${updateInfo?.versionNumber || updateInfo?.latestVersion || updateInfo?.version_number || updateInfo?.name || 'latest'}`}
                            on:click={() => updateContentToLatest(item)}>
          ↑ <span class="ver-label">{updateInfo?.versionNumber || updateInfo?.latestVersion || updateInfo?.version_number || 'latest'}</span>
                  </button>
                  <button class="ghost sm ignore-btn"
                          aria-label="Ignore this version"
                          title="Ignore this version (won't show until a newer one exists)"
                          on:click={() => {
                            const ui = updateInfo; // snapshot
                            if (!ui) return;
                            modsWithUpdates.update(m => { 
                              const nm = new SvelteMap(m); 
                              nm.delete(item); 
                              try {
                                const info = $installedModInfo.find(i => i.fileName === item);
                                if (info && info.projectId) nm.delete(`project:${info.projectId}`);
                              } catch {}
                              return nm; 
                            });
                            ignoreUpdate(item, ui.id, ui.versionNumber || ui.version_number || ui.latestVersion || ui.name);
                          }}>
                    ✖
                  </button>
                </div>
              {:else}
                <span class="tag ok">Up to date</span>
              {/if}
            </td>

            <!-- action buttons -->
            <td class="act">
              <button class="danger sm"
                      disabled={serverRunning}
                      title={serverRunning ? 'Stop the server to delete files' : `Delete ${$activeContentType === CONTENT_TYPES.SHADERS ? 'shader' : 'resource pack'}`}
                      on:click={() => showDeleteConfirmation(item)}>
                {#if serverRunning}🔒{/if} 🗑
              </button>
              {#if info && info.projectId}
                <button class="ghost sm" 
                        title="Change version" 
                        disabled={serverRunning}
                        on:click={() => toggleVersionSelector(item)}>
                  {#if serverRunning}🔒{/if} {$expandedInstalledMod === item ? '▲' : '▼'}
                </button>
              {/if}
            </td>
          </tr>
          
          <!-- Version selector for shaders/resource packs -->
          {#if $expandedInstalledMod === item && info && info.projectId}
            {@const projectId = info.projectId}
            <tr transition:fly="{{ x: 10, duration: 100 }}">
              <td colspan="6" style="padding: 0;">
                <div class="versions">
                {#if installedModVersionsCache[projectId] === undefined}
                  <span class="loading">Loading versions...</span>
                {:else if installedModVersionsCache[projectId]?.length === 0}
                  <span class="err">No versions available</span>
                {:else}
                  {#each installedModVersionsCache[projectId] || [] as version (version.id)}
                    {@const isCurrentVersion = info && info.versionId === version.id}
                    <button
                      class:sel={isCurrentVersion}
                      disabled={isCurrentVersion}
                      on:click={() => switchToContentVersion(item, projectId, version.id)}
                    >
                      {version.versionNumber}
                    </button>
                  {/each}
                {/if}
                </div>
              </td>
            </tr>
          {/if}
        {/each}
      {/if}
    </tbody>
  </table>
{/if}
    </div>



<!-- Confirmation Dialogs -->
<ConfirmationDialog
  bind:visible={confirmDeleteVisible}
  title="Delete Mod"
  message={modToDelete ? `Are you sure you want to delete ${modToDelete}?` : 'Are you sure you want to delete this mod?'}
  confirmText="Delete"
  cancelText="Cancel"
  confirmType="danger"
  on:confirm={confirmDeleteMod}
  on:cancel={() => { confirmDeleteVisible = false; }}
/>

<!-- Modrinth Manual Matching Modal -->
<ModrinthManualMatchingModal
  on:matchConfirmed={handleMatchConfirmed}
/>


<style>
  /* ——————————————————— CSS variables (scoped to component) ——————————————————— */
  .mods-table {
    --row-py: 3px;
    --cell-px: 6px;
    --top-nav: 60px;
  }
  
  /* Color tokens for theming */
  :root {
    --col-ok: #14a047;
    --col-warn: #c9801f;
    --col-danger: #b33;
    --col-primary: #0a84ff;
    --col-server: #2c82ff;
    --col-client: #34d58a;
    --col-both: #f5aa28;
    --bg-primary: #181818;
    --bg-secondary: #141414;
    --bg-tertiary: #1a1a1a;
    --text-primary: #ddd;
    --text-secondary: #aaa;
    --border-color: #333;
  }

  /* ——————————————————— container & table ——————————————————— */
  
  .mods-header { 
    display: flex; 
    justify-content: space-between; 
    align-items: center; 
    gap: 8px; 
    margin-bottom: 6px; 
    flex-wrap: wrap;
  }
  .mods-header .left { display: flex; gap: 6px; flex-wrap: wrap; }
  .bulk { display: flex; gap: 6px; align-items: center; flex-wrap: wrap; }
  
  /* Unified toolbar */
  .mods-toolbar {
    display: flex; 
    align-items: center; 
    gap: 4px; 
    background: var(--bg-tertiary); 
    padding: 3px 8px; 
    border-radius: 6px;
    margin-bottom: 4px;
  }
  
  /* Compatibility Results Styling */
  .compatibility-results {
    background: var(--bg-tertiary);
    border: 1px solid var(--border-color);
    border-radius: 6px;
    padding: 12px;
    margin-bottom: 12px;
    font-size: 0.9rem;
  }
  
  .results-header {
    display: flex;
    justify-content: space-between;
    align-items: center;
    margin-bottom: 8px;
  }
  
  .results-header h4 {
    margin: 0;
    color: var(--text-primary);
    font-size: 1rem;
  }
  
  .close-results {
    background: none;
    border: none;
    color: var(--text-secondary);
    cursor: pointer;
    font-size: 1.2rem;
    padding: 2px 6px;
    border-radius: 3px;
    transition: all 0.15s;
  }
  
  .close-results:hover {
    background: rgba(255, 255, 255, 0.1);
    color: var(--text-primary);
  }
  
  .results-summary {
    display: flex;
    gap: 16px;
    margin-bottom: 12px;
    padding: 8px;
    background: var(--bg-secondary);
    border-radius: 4px;
    flex-wrap: wrap;
  }
  
  .summary-stat {
    color: var(--text-secondary);
    font-size: 0.85rem;
  }
  
  .summary-stat strong {
    color: var(--text-primary);
  }
  
  .issues-list {
    max-height: 300px;
    overflow-y: auto;
  }
  
  .dependency-group {
    margin-bottom: 12px;
    padding: 12px;
    background: var(--bg-secondary);
    border-radius: 6px;
    border-left: 3px solid var(--col-warn);
  }
  
  .dependency-group.dependency-missing {
    border-left-color: var(--col-danger);
  }
  
  .dependency-group.dependency-version_mismatch {
    border-left-color: var(--col-primary);
  }
  
  .dependency-group.dependency-update_available {
    border-left-color: var(--col-ok);
  }
  
  .dependency-group.dependency-disabled {
    border-left-color: var(--col-warn);
  }
  
  .dependency-header {
    display: flex;
    align-items: center;
    gap: 8px;
    margin-bottom: 8px;
    flex-wrap: wrap;
  }
  
  .dependency-type {
    flex-shrink: 0;
    font-weight: 500;
    color: var(--text-primary);
    font-size: 0.9rem;
  }
  
  .dependency-name {
    color: var(--text-primary);
    font-size: 1rem;
  }
  
  .affected-mods {
    margin-bottom: 6px;
    font-size: 0.85rem;
  }
  
  .affected-label {
    color: var(--text-secondary);
    font-weight: 500;
  }
  
  .affected-list {
    color: var(--text-primary);
    margin-left: 4px;
  }
  
  .dependency-message {
    color: var(--text-secondary);
    font-size: 0.8rem;
    font-style: italic;
  }
  
  .version-info {
    color: var(--col-primary);
    font-weight: 500;
  }
  
  .issue-message {
    font-style: italic;
    color: var(--text-secondary);
  }
  
  .dependency-download-btn {
    background: var(--col-primary);
    color: white;
    border: none;
    padding: 4px 8px;
    border-radius: 4px;
    font-size: 0.8rem;
    cursor: pointer;
    transition: all 0.15s;
    margin-left: 8px;
    flex-shrink: 0;
  }
  
  .dependency-download-btn:hover:not(:disabled) {
    background: #0066cc;
    transform: translateY(-1px);
  }
  
  .dependency-download-btn:disabled {
    background: var(--text-secondary);
    cursor: not-allowed;
    opacity: 0.6;
  }
  
  .bulk-download-section {
    margin-bottom: 12px;
    padding: 8px;
    background: var(--bg-secondary);
    border-radius: 4px;
    border-left: 3px solid var(--col-primary);
  }
  
  .bulk-download-btn {
    background: var(--col-primary);
    color: white;
    border: none;
    padding: 8px 16px;
    border-radius: 4px;
    font-size: 0.9rem;
    font-weight: 500;
    cursor: pointer;
    transition: all 0.15s;
    width: 100%;
  }
  
  .bulk-download-btn:hover:not(:disabled) {
    background: #0066cc;
    transform: translateY(-1px);
  }
  
  .bulk-download-btn:disabled {
    background: var(--text-secondary);
    cursor: not-allowed;
    opacity: 0.6;
  }
  
  .no-issues {
    text-align: center;
    padding: 16px;
    color: var(--col-ok);
  }
  
  .no-issues p {
    margin: 0;
    font-size: 0.9rem;
  }
  
  /* Table container - ensure no width constraints */
  .table-container {
    width: 100%;
  }
  
  .mods-table { 
    width: 100%; 
    border-collapse: collapse; 
    font-size: 0.9rem;
    background: linear-gradient(to bottom, var(--bg-primary), var(--bg-secondary));
    table-layout: fixed; /* FORCE FIXED LAYOUT - prevents action column cutoff */
    margin-top: 8px;
  }
  .mods-table th, .mods-table td { 
    padding: var(--row-py) var(--cell-px); 
    overflow: hidden; /* Prevent content spillover */
    text-overflow: ellipsis; /* Add ellipsis for long text */
    white-space: nowrap; /* Prevent text wrapping that breaks layout */
  }
  .mods-table tr { 
    border-left: 4px solid transparent; 
    transition: background-color 0.15s, box-shadow 0.15s, border-left-color 0.15s; 
  }
  .mods-table thead { 
    background: var(--bg-tertiary); 
    position: sticky; 
    top: calc(var(--top-nav) + 6px); 
    z-index: 6; 
  }
  .mods-table tbody tr:nth-child(even) { background: rgba(24, 24, 24, 0.8); }
  .mods-table tbody tr:hover { 
    background: #212121; 
    box-shadow: 0 0 4px rgba(255, 255, 255, 0.1);
  }
  .mods-table tbody tr:hover[style*="border-left-color:#2c82ff"] {
    box-shadow: 0 0 6px rgba(44, 130, 255, 0.3);
  }
  .mods-table tbody tr:hover[style*="border-left-color:#34d58a"] {
    box-shadow: 0 0 6px rgba(52, 213, 138, 0.3);
  }
  .mods-table tbody tr:hover[style*="border-left-color:#f5aa28"] {
    box-shadow: 0 0 6px rgba(245, 170, 40, 0.3);
  }
  .mods-table tbody tr:focus-within { 
    background: #232323; 
    outline: 1px solid #3a90ff; 
  }
  
  /* Column widths - Main table - PERCENTAGE BASED */
  .mods-table th.chk, .mods-table td:nth-child(1) { width: 5%; min-width: 40px; }
  .mods-table th:nth-child(2), .mods-table td:nth-child(2) { width: 25%; min-width: 150px; } /* Mod name */
  .mods-table th.loc, .mods-table td:nth-child(3) { width: 20%; min-width: 120px; } /* Location */
  .mods-table th.ver, .mods-table td:nth-child(4) { width: 20%; min-width: 200px; } /* Current */
  .mods-table th.alert, .mods-table td:nth-child(5) { width: 4%; min-width: 28px; } /* Alert */
  .mods-table th.status, .mods-table td:nth-child(6) { width: 10%; min-width: 70px; } /* Status */
  .mods-table th.upd, .mods-table td:nth-child(7) { width: 10%; min-width: 70px; } /* Update */
  .mods-table th.act, .mods-table td:nth-child(8) { width: 11%; min-width: 90px; } /* Actions */
  


  /* ——————————————————— row specifics ——————————————————— */
  tr.selected { background: #23324a; }
  
  /* Disabled mod styling - exactly like client mods */
  tr.disabled {
    opacity: 0.7;
    background: rgba(139, 69, 19, 0.15) !important;
    transition: all 0.3s ease;
  }
  
  .mc-tag { 
    background: var(--border-color); 
    color: var(--text-secondary); 
    padding: 0 4px; 
    border-radius: 3px; 
    margin-left: 4px; 
    font-size: 0.75rem; 
  }
  .loc-select { 
    font-size: 0.75rem; 
    background: var(--bg-secondary); 
    border: 1px solid var(--border-color); 
    color: var(--text-primary); 
    border-radius: 3px; 
    padding: 1px 2px;
    appearance: none;
    background-image: url('data:image/svg+xml;charset=US-ASCII,<svg xmlns="http://www.w3.org/2000/svg" width="10" height="6" fill="%23999"><path d="M0 0l5 6 5-6z"/></svg>');
    background-repeat: no-repeat;
    background-position: 95% 50%;
    background-size: 10px;
    padding-right: 16px;
  }
  .req { 
    font-size: 0.75rem; 
    color: var(--text-secondary); 
    margin-left: 4px; 
    display: flex;
    align-items: center;
    gap: 2px;
  }
  .ver, .upd, .alert, .status { text-align: center; white-space: nowrap; }
  
  /* Version column specific styling with hover tooltip */
  .ver {
    font-size: 0.8rem; /* Slightly smaller to prevent truncation */
    position: relative;
  }
  
  .ver code {
    font-size: 0.75rem; /* Even smaller for version numbers */
    padding: 1px 3px;
    background: rgba(255, 255, 255, 0.1);
    border-radius: 2px;
    cursor: help; /* Show it's hoverable */
  }

  .version-button {
    font-size: 0.75rem;
    padding: 1px 3px;
    background: rgba(255, 255, 255, 0.1);
    border-radius: 2px;
    border: none;
    color: inherit;
    font-family: monospace;
    cursor: pointer;
    transition: all 0.15s;
  }

  .version-button:hover {
    background: rgba(255, 255, 255, 0.2);
    transform: translateY(-1px);
  }

  .reset-match-btn {
    background: none;
    border: none;
    font-size: 0.6rem;
    cursor: pointer;
    opacity: 0.5;
    padding: 1px 2px;
    border-radius: 2px;
    transition: opacity 0.2s, background-color 0.2s;
    margin-left: 4px;
    color: #94a3b8;
    vertical-align: middle;
  }

  .reset-match-btn:hover {
    opacity: 1;
    background: rgba(255, 255, 255, 0.1);
    color: #f1f5f9;
  }
  
  /* Hover tooltip for version with enhanced installation date display */
  .ver code:hover::after {
    content: attr(title);
    position: absolute;
    bottom: 100%;
    left: 50%;
    transform: translateX(-50%);
    background: #2a2a2a;
    color: #e2e8f0;
    padding: 10px 14px;
    border-radius: 8px;
    font-size: 0.8rem;
    white-space: pre-line;
    z-index: 1000;
    pointer-events: none;
    border: 1px solid #4a5568;
    box-shadow: 0 6px 16px rgba(0, 0, 0, 0.4);
    max-width: 280px;
    text-align: left;
    line-height: 1.5;
    font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, sans-serif;
  }
  
  /* Update column with tooltip */
  .upd {
    position: relative;
  }
  /* Prevent stray text nodes (e.g., a lone '.') from rendering next to the button */
  td.upd { font-size: 0; }
  td.upd > .tag { font-size: 0.72rem; }
  td.upd { width: 170px; } /* ensure enough horizontal space for update + ignore */
  
  .tag.clickable:hover::after {
    content: attr(title);
    position: absolute;
    bottom: 100%;
    left: 50%;
    transform: translateX(-50%);
    background: #333;
    color: white;
    padding: 4px 8px;
    border-radius: 4px;
    font-size: 0.8rem;
    white-space: nowrap;
    z-index: 1000;
    pointer-events: none;
    border: 1px solid #555;
  }
  
  .alert { 
    text-align: center; 
    padding: 0 !important;
    width: 28px;
  }
  .warn-badge {
    font-size: 0.9rem;
    color: var(--col-warn);
    cursor: help;
    transition: all 0.15s;
    opacity: 0.7;
  }
  .warn-badge:hover {
    color: #ff9500;
    filter: drop-shadow(0 0 2px rgba(255, 149, 0, 0.5));
    opacity: 1;
  }
  
  /* Checkbox column */
  .chk {
    position: relative;
    text-align: center;
  }
  .sel-all {
    color: #666;
    cursor: pointer;
    user-select: none;
    transition: color 0.15s;
  }
  .sel-all:hover {
    color: var(--text-secondary);
  }
  .chk input[type="checkbox"] {
    position: relative;
    z-index: 1;
  }
  .ok { color: var(--col-ok); font-size: 0.75rem; }
  .act { 
    white-space: nowrap; 
    text-align: center; /* Center align for better visual balance */
  }
  
  .act button {
    display: block;
    margin-bottom: 2px;
    width: 100%;
    font-size: 0.7rem;
    padding: 1px 4px;
  }
  
  .act button:last-child {
    margin-bottom: 0;
  }
  .no-results {
    text-align: center;
    color: #666;
    font-style: italic;
    padding: 20px !important;
  }
  
  /* ——————————————————— compact tag badges ——————————————————— */
  .tag {
    display: inline-block; 
    padding: 0 6px; 
    border-radius: 3px;
    font-size: 0.72rem; 
    line-height: 18px; 
    user-select: none;
    border: none;
    font-family: inherit;
  }
  .tag.ok { background: #123b20; color: var(--col-ok); }
  .tag.new { background: #0b2c48; color: #4af; }
  .tag.clickable { 
    cursor: pointer; 
    transition: all 0.15s; 
  }
  .tag.clickable:hover:not(:disabled) { 
    background: #165a7a; 
    color: #6cf; 
  }
  .tag.clickable:disabled { 
    opacity: 0.5; 
    cursor: not-allowed; 
  }

  /* Update actions wrapper (update + ignore) */
  .update-actions { display: inline-flex; align-items: center; gap: 4px; }
  .ignore-btn { 
    line-height: 1; 
    padding: 2px 4px; 
    background: #222; 
    border: 1px solid #333; 
    color: #888; 
  }
  .ignore-btn:hover:not(:disabled) { background:#333; color:#bbb; }
  .update-actions.compact { 
    max-width: 100%; 
    display: flex; 
    align-items: stretch; 
    gap: 4px; 
  }
  .update-actions.compact .upd-btn { 
    flex: 1 1 auto; 
    min-width: 0; 
    display: inline-flex; 
    align-items: center; 
    gap: 2px; 
  }
  .update-actions.compact .ignore-btn { 
    flex: 0 0 26px; 
    display: inline-flex; 
    justify-content: center; 
    align-items: center; 
  }
  .update-actions.compact .upd-btn .ver-label { 
    max-width: calc(100% - 4px); 
    overflow: hidden; 
    text-overflow: ellipsis; 
    white-space: nowrap; 
    display: inline-block; 
  }

  /* Status badges */
  .status-badge {
    padding: 0.25rem 0.5rem;
    border-radius: 4px;
    font-size: 0.55rem; /* Further reduced from 0.6rem for consistency */
    font-weight: 500;
    text-transform: uppercase;
  }

  .status-badge.enabled {
    background: rgba(34, 197, 94, 0.2);
    color: #22c55e;
    border: 1px solid rgba(34, 197, 94, 0.3);
  }

  .status-badge.disabled {
    background: rgba(239, 68, 68, 0.2);
    color: #ef4444;
    border: 1px solid rgba(239, 68, 68, 0.3);
  }

  /* ——————————————————— versions expander ——————————————————— */
  .versions { 
    display: flex; 
    flex-wrap: wrap; 
    gap: 4px; 
    padding: 8px; 
    background: #101010; 
    border: 1px solid #333; 
    border-radius: 4px;
    width: 100%;
    box-sizing: border-box;
  }
  .versions button { 
    padding: 4px 8px; 
    font-size: 0.75rem; 
    border-radius: 3px; 
    background: #262626; 
    border: 1px solid #444; 
    color: #ccc; 
    cursor: pointer;
    flex-shrink: 0;
    white-space: nowrap;
  }
  .versions button:hover:not(:disabled) { background: #2d2d2d; }
  .versions button.sel { 
    background: #09f; 
    border-color: #49f; 
    color: #fff; 
    cursor: default; 
  }
  .err, .loading { color: #f66; font-size: 0.8rem; }

  /* ——————————————————— buttons ——————————————————— */
  button { font: inherit; cursor: pointer; border: none; border-radius: 3px; }
  button:disabled { opacity: 0.5; cursor: not-allowed; }
  .sm { font-size: 0.75rem; padding: 2px 6px; }
  .ghost { background: none; color: #bbb; }
  .ghost:hover:not(:disabled) { color: #eee; }
  .primary { background: var(--col-primary); color: #fff; }
  .primary:hover:not(:disabled) { background: #006dd9; }
  .danger { background: var(--col-danger); color: #fff; }
  .danger:hover:not(:disabled) { background: #922; }
  .warn { background: var(--col-warn); color: #222; }
  .warn:hover:not(:disabled) { background: #ad7f00; }


  /* ——————————————————— toolbar buttons ——————————————————— */
  .icon-btn {
    padding: 4px 8px; 
    font-size: 0.8rem; 
    background: none; 
    color: #bbb;
    border: none;
    border-radius: 3px;
    cursor: pointer;
    transition: all 0.15s;
  }
  .icon-btn:hover:not(:disabled) { 
    color: #fff; 
    background: #2a2a2a; 
    border-radius: 4px;
    box-shadow: 0 1px 3px rgba(0, 0, 0, 0.3);
  }
  
  .add-mods-btn-outline {
    padding: 4px 8px;
    font-size: 0.8rem;
    background: none;
    color: #bbb;
    border: 1px solid #444;
    border-radius: 3px;
    cursor: pointer;
    transition: all 0.15s;
  }
  .add-mods-btn-outline:hover:not(:disabled) {
    color: #ddd;
    border-color: #666;
    background: #2a2a2a;
  }
  .add-mods-btn-outline.drag-highlight {
    outline: 2px dashed #4af;
    background: #111;
    color: #4af;
  }
  
  /* ——————————————————— search box ——————————————————— */
  .search-container {
    position: relative;
    display: flex;
    align-items: center;
  }
  .search-input {
    width: 160px;
    padding: 3px 8px;
    font-size: 0.8rem;
    background: var(--bg-tertiary);
    border: 1px solid var(--border-color);
    color: var(--text-primary);
    border-radius: 3px;
    transition: all 0.15s;
  }
  .search-input:focus {
    outline: none;
    border-color: #4af;
    background: #222;
    box-shadow: 0 0 0 2px rgba(68, 170, 255, 0.2);
  }
  .search-clear {
    position: absolute;
    right: 4px;
    background: none;
    border: none;
    color: #888;
    font-size: 1rem;
    cursor: pointer;
    padding: 0;
    width: 16px;
    height: 16px;
    display: flex;
    align-items: center;
    justify-content: center;
    border-radius: 2px;
  }
  .search-clear:hover {
    background: #333;
    color: #ccc;
  }
  
  /* ——————————————————— keyboard hint ——————————————————— */
  .keyboard-hint {
    font-size: 0.9rem;
    color: #666;
    cursor: help;
    padding: 2px 4px;
    border-radius: 3px;
    transition: color 0.15s;
  }
  .keyboard-hint:hover {
    color: #aaa;
  }
  
  /* ——————————————————— drop zone ——————————————————— */
  .drop-zone-container {
    margin: 8px 0;
    display: flex;
    justify-content: center;
    align-items: center;
  }
  .drop-zone-full.drag-highlight {
    outline: 2px dashed #4af;
    background: rgba(68, 170, 255, 0.1);
  }
  
  .drop-zone-full {
    position: relative;
    padding: 24px;
    border: 2px dashed #444;
    border-radius: 8px;
    background: #1a1a1a;
    text-align: center;
    max-width: 600px;
    width: 100%;
  }
  .drop-zone-content {
    display: flex;
    flex-direction: column;
    align-items: center;
    gap: 8px;
  }
  .drop-icon {
    font-size: 2rem;
  }
  .drop-or {
    color: #666;
    margin: 0;
  }
  .browse-btn {
    background: #2a2a2a;
    color: #ddd;
    border: 1px solid #444;
    padding: 8px 16px;
    border-radius: 4px;
    cursor: pointer;
  }
  .browse-btn:hover {
    background: #333;
  }
  .collapse-btn {
    position: absolute;
    top: 8px;
    right: 8px;
    background: #333;
    color: #bbb;
    border: none;
    width: 24px;
    height: 24px;
    border-radius: 3px;
    cursor: pointer;
    display: flex;
    align-items: center;
    justify-content: center;
  }
  .collapse-btn:hover {
    background: #444;
    color: #ddd;
  }



  /* ——————————————————— responsive ——————————————————— */
  @media (min-width: 900px) {
    /* Adaptive row height - more compact when there's space */
    .mods-table {
      --row-py: 2px;
  }
    .mods-table tbody tr {
      height: 44px;
    }
  }
  
  @media (max-width: 768px) {
    .mods-header { flex-direction: column; align-items: stretch; }
    .mods-header .left { justify-content: center; }
    .bulk { justify-content: center; }
    .loc { display: none; }
    .act { text-align: center; }  }
  
  /* Exception columns that need wrapping */
  .mods-table td:nth-child(3), /* Location column */
  .mods-table td:nth-child(4), /* Current version (now allows wrapping for confirmation UI) */
  .mods-table td:nth-child(8) { /* Actions column */
    white-space: normal; /* Allow wrapping for these columns */
  }
  
  /* Update column should stay nowrap */
  .mods-table td:nth-child(7) { /* Update */
    white-space: nowrap;
    overflow: hidden;
    text-overflow: ellipsis;
  }
</style>