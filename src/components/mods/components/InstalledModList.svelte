<script>
  import { createEventDispatcher, onMount } from 'svelte';
  import { fly } from 'svelte/transition';
  
  // Import existing stores
  import {
    installedMods,
    installedModInfo,
    modsWithUpdates,
    getUpdateCount,
    expandedInstalledMod,
    isCheckingUpdates,
    successMessage,
    errorMessage,
    disabledMods,
    disabledModUpdates,
    getCategorizedMods,
    updateModCategory,
    updateModRequired
  } from '../../../stores/modStore.js';
  import { serverState } from '../../../stores/serverState.js';
  
  // Import existing API functions
  import { loadMods, deleteMod, checkForUpdates, enableAndUpdateMod, fetchModVersions } from '../../../utils/mods/modAPI.js';
  import { safeInvoke } from '../../../utils/ipcUtils.js';
  import { checkDependencyCompatibility } from '../../../utils/mods/modCompatibility.js';
  import { checkModDependencies } from '../../../utils/mods/modDependencyHelper.js';

  
  // Import confirmation dialog
  import ConfirmationDialog from '../../common/ConfirmationDialog.svelte';

  // Props
  export let serverPath = '';

  // Event dispatcher
  const dispatch = createEventDispatcher();

  // Local state
  let selectedMods = new Set();
  let installedModVersionsCache = {};
  let confirmDeleteVisible = false;
  let modToDelete = null;

  let updateAllInProgress = false;
  // Initialize drop zone state from localStorage
  let dropZoneCollapsed = localStorage.getItem('minecraft-core-drop-zone-collapsed') === 'true';
  
  // State for enhancements  
  let searchTerm = '';
  let isDragover = false;

  // Get stores 
  const categorizedModsStore = getCategorizedMods();
  const updateCountStore = getUpdateCount();

  // Reactive values
  $: updateCount = $updateCountStore;
  $: serverRunning = $serverState.status === 'Running';
  
  // Auto-collapse drop zone after successful mod upload
  $: if ($installedMods.length > 0) {
    // Only auto-collapse if we haven't done so already
    if (!localStorage.getItem('minecraft-core-drop-zone-collapsed')) {
      dropZoneCollapsed = true;
      localStorage.setItem('minecraft-core-drop-zone-collapsed', 'true');
    }
  }
  
  // Filter mods based on search term
  $: filteredMods = $installedMods.filter(mod => {
    if (!searchTerm) return true;
    const modInfo = $installedModInfo.find(m => m.fileName === mod);
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
    // Existing drop handling logic would go here
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
    input.click();
    // File handling will be done via drag-and-drop for now
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
    selectedMods = new Set(selectedMods);
  }



  function toggleSelectAll() {
    if (selectedMods.size === filteredMods.length) {
      selectedMods = new Set();
    } else {
      selectedMods = new Set(filteredMods);
    }
  }



  // Mod management functions
  async function handleCheckUpdates() {
    try {
      await checkForUpdates(serverPath);
      await loadMods(serverPath);
      successMessage.set('Update check completed successfully!');
      setTimeout(() => successMessage.set(''), 3000);
    } catch (error) {
      errorMessage.set(`Failed to check for updates: ${error.message}`);
    }
  }

  async function checkAllModsCompatibility() {
    try {
      const modsWithInfo = $installedModInfo.filter(mod => 
        mod.projectId && 
        mod.fileName && 
        !$disabledMods.has(mod.fileName)
      );
      
      if (modsWithInfo.length === 0) {
        successMessage.set('No mods with project information found');
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
          });
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
          console.warn(`Error checking compatibility for mod ${mod.fileName}:`, error);
        }
      }
      
      if (allIssues.length > 0) {
        successMessage.set(`Found ${allIssues.flatMap(i => i.issues).length} compatibility issues in ${allIssues.length} mods`);
      } else {
        successMessage.set(`All mods compatible! Checked ${checkedCount} mods.`);
      }
    } catch (error) {
      errorMessage.set(`Failed to check compatibility: ${error.message}`);
    }
  }

  async function updateAllMods() {
    const modsWithUpdatesList = [];
    for (const [modName, updateInfo] of $modsWithUpdates.entries()) {
      if (modName.startsWith('project:')) continue;
      if ($disabledMods.has(modName)) continue;
      
      const modInfo = $installedModInfo.find(m => m.fileName === modName);
      if (modInfo && modInfo.projectId) {
        modsWithUpdatesList.push({
          modName,
          projectId: modInfo.projectId,
          versionId: updateInfo.id,
          version: updateInfo
        });
      }
    }
    
    if (modsWithUpdatesList.length === 0) return;
    
    updateAllInProgress = true;
    
    try {
      for (const mod of modsWithUpdatesList) {
        await dispatch('updateMod', {
          modName: mod.modName,
          projectId: mod.projectId,
          versionId: mod.versionId
        });
      }
      
      // Force refresh mod list and update checks to ensure UI is current
      await loadMods(serverPath);
      await checkForUpdates(serverPath);
      successMessage.set(`Updated ${modsWithUpdatesList.length} mods successfully!`);
    } catch (error) {
      errorMessage.set(`Failed to update all mods: ${error.message}`);
    } finally {
      updateAllInProgress = false;
    }
  }

  async function handleDeleteSelected() {
    if (selectedMods.size === 0) return;
    
    try {
      for (const modName of selectedMods) {
        await deleteMod(modName, serverPath, true);
      }
      selectedMods = new Set();
      await loadMods(serverPath);
      dispatch('modRemoved');
    } catch (error) {
      errorMessage.set(`Failed to delete selected mods: ${error.message}`);
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
        const newMods = new Set(mods);
        
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
      selectedMods = new Set();
      
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
    
    const modInfo = $installedModInfo.find(m => m.fileName === modName);
    if (modInfo && modInfo.projectId) {
      try {
        const versions = await fetchModVersions(modInfo.projectId);
        installedModVersionsCache = { 
          ...installedModVersionsCache, 
          [modInfo.projectId]: versions 
        };
      } catch (error) {
        console.warn('Failed to fetch versions:', error);
      }
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
    const modInfo = $installedModInfo.find(m => m.fileName === modName);
    
    if (!updateInfo || !modInfo || !modInfo.projectId) return;
    
    dispatch('updateMod', {
      modName,
      projectId: modInfo.projectId,
      versionId: updateInfo.id
    });
  }

  function showDeleteConfirmation(modName) {
    modToDelete = modName;
    confirmDeleteVisible = true;
  }

  async function confirmDeleteMod() {
    if (modToDelete) {
      const wasDisabled = $disabledMods.has(modToDelete);
      
      const deleteSuccess = await deleteMod(modToDelete, serverPath, true);
      
      if (deleteSuccess && wasDisabled) {
        disabledMods.update(mods => {
          const newMods = new Set(mods);
          newMods.delete(modToDelete);
          return newMods;
        });
        
        await safeInvoke('save-disabled-mods', serverPath, Array.from($disabledMods));
      }
      
      modToDelete = null;
      confirmDeleteVisible = false;
      dispatch('modRemoved');
    }
  }



  async function confirmToggleModStatus(modName, isDisabled) {
    try {
        disabledMods.update(mods => {
          const newMods = new Set(mods);
        if (isDisabled) {
          newMods.delete(modName);
      } else {
          newMods.add(modName);
        }
          return newMods;
        });
      
        await safeInvoke('save-disabled-mods', serverPath, Array.from($disabledMods));
        
      const action = isDisabled ? 'enabled' : 'disabled';
      successMessage.set(`Mod ${modName} ${action} successfully.`);
        setTimeout(() => successMessage.set(''), 3000);
      } catch (error) {
        errorMessage.set(`Failed to toggle mod: ${error.message}`);
    }
  }

  async function handleEnableAndUpdate(modFileName) {
    const updateInfo = $disabledModUpdates.get(modFileName);
    
    if (!updateInfo) {
      errorMessage.set('No update information available for this mod');
      return;
    }
    
    try {
      const success = await enableAndUpdateMod(
        serverPath,
        modFileName,
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
      const { loadModCategories } = await import('../../../stores/modStore.js');
      await loadModCategories();
      
      // Load disabled mods from storage
      if (serverPath) {
        try {
          const disabledModsList = await safeInvoke('get-disabled-mods', serverPath);
          if (Array.isArray(disabledModsList)) {
            disabledMods.set(new Set(disabledModsList));
          }
        } catch (error) {
          console.warn('Failed to load disabled mods:', error);
        }
      }
    } catch (error) {
      console.warn('Failed to load mod settings:', error);
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
      <button class="icon-btn" on:click={checkAllModsCompatibility} title="Check Compatibility">
        ✅
      </button>
      
      <!-- Search box -->
      <div class="search-container">
        <input 
          type="text" 
          class="search-input" 
          placeholder="Search mods ( / )"
          bind:value={searchTerm}
        />
        {#if searchTerm}
          <button class="search-clear" on:click={() => searchTerm = ''} title="Clear search">×</button>
        {/if}
      </div>
      
      <!-- Add mods button -->
      <button class="add-mods-btn-outline" 
              class:drag-highlight={isDragover}
              on:click={toggleDropZone} 
              on:dragenter={handleAddButtonDragEnter}
              on:dragover={handleDragOver}
              on:dragleave={handleDragLeave}
              on:drop={handleDrop}
              title="Add mods by dragging files or clicking to browse">
        📦 Add Mods
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
      <button class="{buttonClass} sm" on:click={handleBulkToggle} disabled={serverRunning}>
        {#if serverRunning}🔒{/if} 
        {buttonText === 'Enable' ? '✅' : buttonText === 'Disable' ? '🚫' : '⚡'} 
        {buttonText} Selected ({selectedMods.size})
      </button>
    </div>
  {/if}
</div>

<!-- Optional expanded drop zone (only shown when button is clicked) -->
{#if !dropZoneCollapsed}
<div class="drop-zone-container">
    <div class="drop-zone-full" 
         class:drag-highlight={isDragover}
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

<!-- Installed Mods table -->
<div class="table-container">
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
      {@const modInfo = $installedModInfo.find(m => m.fileName === mod)}
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
          <strong>{modCategoryInfo?.name || mod}</strong>
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
          {#if modInfo && modInfo.versionNumber}
            <code title={modInfo.versionNumber}>{modInfo.versionNumber}</code>
          {/if}
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
            {#if isDisabled && $disabledModUpdates.has(mod)}
              {@const updateInfo = $disabledModUpdates.get(mod)}
              <button class="tag new clickable" 
                      disabled={serverRunning}
                      on:click={() => handleEnableAndUpdate(mod)}
                      title={serverRunning ? 'Server must be stopped to enable and update mods' : `Enable and update to ${updateInfo.latestVersion}`}>
                {#if serverRunning}🔒{/if} ↑ {updateInfo.latestVersion}
              </button>
            {:else if !isDisabled && $modsWithUpdates.has(mod)}
            {@const updateInfo = $modsWithUpdates.get(mod)}
            <button class="tag new clickable"
                    disabled={serverRunning}
                    on:click={() => updateModToLatest(mod)}
                    title={serverRunning ? 'Server must be stopped to update mods' : `Update to ${updateInfo.versionNumber}`}>
              {#if serverRunning}🔒{/if} ↑ {updateInfo.versionNumber}
            </button>
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
        <tr transition:fly="{{ x: 10, duration: 100 }}">
            <td colspan="8">
            <div class="versions">
              {#if !installedModVersionsCache[modInfo?.projectId]}
                <span class="loading">Loading versions...</span>
              {:else if installedModVersionsCache[modInfo?.projectId]?.length === 0}
                <span class="err">No versions available</span>
              {:else}
                {#each installedModVersionsCache[modInfo?.projectId] || [] as version}
                  {@const isCurrentVersion = modInfo && modInfo.versionId === version.id}
                  <button
                    class:sel={isCurrentVersion}
                    disabled={isCurrentVersion}
                    on:click={() => switchToVersion(mod, modInfo.projectId, version.id)}>
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
  .mods-table th.ver, .mods-table td:nth-child(4) { width: 15%; min-width: 100px; } /* Current */
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
  
  /* Hover tooltip for version */
  .ver code:hover::after {
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
  
  /* Update column with tooltip */
  .upd {
    position: relative;
  }
  
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
    padding: 4px; 
    background: #101010; 
    border: 1px solid #333; 
    border-radius: 4px; 
  }
  .versions button { 
    padding: 2px 6px; 
    font-size: 0.75rem; 
    border-radius: 3px; 
    background: #262626; 
    border: 1px solid #444; 
    color: #ccc; 
    cursor: pointer; 
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
    .act { text-align: center; }
  }

  /* Exception columns that need wrapping */
  .mods-table td:nth-child(3), /* Location column */
  .mods-table td:nth-child(8) { /* Actions column */
    white-space: normal; /* Allow wrapping for these columns */
  }
  
  /* Version and current columns should stay nowrap */
  .mods-table td:nth-child(4), /* Current version */
  .mods-table td:nth-child(7) { /* Update */
    white-space: nowrap;
    overflow: hidden;
    text-overflow: ellipsis;
  }
</style> 