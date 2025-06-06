<!-- @ts-ignore --><script>  import { createEventDispatcher } from 'svelte';  import { onMount, onDestroy } from 'svelte';  import { get } from 'svelte/store';  import {     installedMods,     installedModInfo,     modsWithUpdates,    updateCount,    expandedInstalledMod,    isCheckingUpdates,    minecraftVersion,    successMessage,    errorMessage,    disabledMods,    categorizedMods,    updateModCategory,    updateModRequired  } from '../../../stores/modStore.js';  import { loadMods, deleteMod, checkForUpdates } from '../../../utils/mods/modAPI.js';  import { safeInvoke } from '../../../utils/ipcUtils.js';
import ModRow from './ModRow.svelte';
import CompatibilityWarningDialog from './CompatibilityWarningDialog.svelte';
import {
  toggleInstalledVersionSelector,
  clearModStatus,
  updateInstalledMod,
  updateModToLatest,
  proceedWithUpdate
} from '../../../utils/mods/installedModActions.js';
  import ConfirmationDialog from '../../common/ConfirmationDialog.svelte';
  import { slide } from 'svelte/transition';
  import { checkDependencyCompatibility } from '../../../utils/mods/modCompatibility.js';
  import { checkModDependencies } from '../../../utils/mods/modDependencyHelper.js';
  import { serverState } from '../../../stores/serverState.js';
  
  // Props
  export let serverPath = '';
  
  // Local state
  let installedModVersionsCache = {};
  let modStatus = new Map();
  let confirmDeleteVisible = false;
  let modToDelete = null;
  let compatibilityWarnings = [];
  let showCompatibilityWarning = false;
  let modsToUpdate = [];
  let updateAllInProgress = false;
  let confirmDisableVisible = false;
  let modToToggle = null;
  let selectedMods = new Set();
  let selectedDisabledMods = new Set();
  let confirmBulkDeleteVisible = false;
  let confirmBulkDisableVisible = false;
  let confirmBulkDeleteDisabledVisible = false;
  let confirmBulkEnableDisabledVisible = false;
  
  // Event dispatcher
  const dispatch = createEventDispatcher();
  
  // Track download events
  let downloadListener;
  
  // Browser-compatible path utilities
  function dirname(path) {
    return path.replace(/\\/g, '/').replace(/\/[^/]*$/, '');
  }
  
  function basename(path) {
    return path.replace(/\\/g, '/').split('/').pop();
  }
  
  function join(...parts) {
    return parts.map(part => part.replace(/^\/|\/$/g, '')).filter(Boolean).join('/');
  }
  
  
  /**
   * Show delete confirmation for a mod
   * @param {string} modName - Mod filename
   */
  function showDeleteConfirmation(modName) {
    modToDelete = modName;
    confirmDeleteVisible = true;
  }
  
  /**
   * Handle mod deletion after confirmation
   */
  async function confirmDeleteMod() {
    if (modToDelete) {
      await deleteMod(modToDelete, serverPath, true);
      modToDelete = null;
      confirmDeleteVisible = false;
    }
  }
  
  /**
   * Show disable/enable confirmation for a mod
   * @param {string} modName - Mod filename
   * @param {boolean} isDisabled - Whether the mod is currently disabled
   */
  function showDisableConfirmation(modName, isDisabled) {
    modToToggle = { name: modName, isDisabled };
    confirmDisableVisible = true;
  }
  
  /**
   * Toggle a mod's disabled status
   */
  async function confirmToggleModStatus() {
    if (modToToggle) {
      if (modToToggle.isDisabled) {
        // Enable the mod
        disabledMods.update(mods => {
          const newMods = new Set(mods);
          newMods.delete(modToToggle.name);
          return newMods;
        });
      } else {
        // Disable the mod
        disabledMods.update(mods => {
          const newMods = new Set(mods);
          newMods.add(modToToggle.name);
          return newMods;
        });
      }
      
      // Save the disabled mods state to a config file
      try {
        await safeInvoke('save-disabled-mods', serverPath, Array.from($disabledMods));
        
        // Reload the mods list to show the updated disabled status
        await loadMods(serverPath);
        
        // Show success message
        const action = modToToggle.isDisabled ? 'enabled' : 'disabled';
        successMessage.set(`Mod ${modToToggle.name} ${action} successfully.`);
        
        // Clear message after a delay
        setTimeout(() => {
          successMessage.set('');
        }, 3000);
      } catch (error) {
        console.error('Failed to save disabled mods:', error);
        errorMessage.set(`Failed to toggle mod: ${error.message}`);
      }
      
      // Reset the state
      modToToggle = null;
      confirmDisableVisible = false;
    }
  }
  
  /**
   * Handle Refresh button click
   */
  async function handleRefreshClick() {
    try {
      // Reload mods first
      await loadMods(serverPath);
      
      // Then check for updates
      await checkForUpdates(serverPath);
      
      // Notify parent component
      dispatch('refresh');
    } catch (error) {
      console.error('Error refreshing mod list:', error);
    }
  }
  
  /**
   * Handle Check Updates button click
   */
  async function handleCheckUpdates() {
    try {
      // Check for updates
      await checkForUpdates(serverPath);
      
      // Force refresh the mod list to ensure we have the latest information
      await loadMods(serverPath);
      
      // Show success message
      successMessage.set('Update check completed successfully!');
      
      // Clear message after 3 seconds
      setTimeout(() => {
        successMessage.set('');
      }, 3000);
    } catch (error) {
      console.error('Error checking for updates:', error);
      errorMessage.set(`Failed to check for updates: ${error.message}`);
    }
  }
  
  /**
   * Check compatibility of all installed mods
   * This will scan all installed mods for missing dependencies
   */
  async function checkAllModsCompatibility() {
    try {
      // Only check enabled mods
      const modsWithInfo = $installedModInfo.filter(mod => mod.projectId && !$disabledMods.has(mod.fileName));
      
      if (modsWithInfo.length === 0) {
        successMessage.set('No mods with project information found');
        return;
      }
      
      // Show a message that we're checking
      successMessage.set('Checking mod compatibility...');
      
      // Keep track of all issues found
      const allIssues = [];
      let checkedCount = 0;
      
      // For each mod, check dependencies using the helper
      for (const mod of modsWithInfo) {
        try {
          // Use unified dependency check to gather all types of dependencies
          const deps = await checkModDependencies({
            id: mod.projectId,
            selectedVersionId: mod.versionId,
            source: mod.source || 'modrinth'
          });
          console.log(`[DEBUG] Dependencies for ${mod.fileName}:`, deps); // Debug log
          checkedCount++;
          console.log(`[DEBUG] Found ${deps.length} dependencies for installed mod: ${mod.fileName}`, deps);
          
          // Now check for compatibility issues (missing, mismatches, updates)
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
          console.error(`Failed to check mod ${mod.fileName}:`, error);
        }
      }
      
      // Show compatibility warnings if any were found
      if (allIssues.length > 0) {
        // Flatten all issues for the warning dialog
        compatibilityWarnings = allIssues.flatMap(item => 
          item.issues.map(issue => ({
            ...issue,
            modName: item.modName
          }))
        );
        
        showCompatibilityWarning = true;
        // We don't set modsToUpdate here because this is just a check
        
        // Update the success message
        successMessage.set(`Found ${compatibilityWarnings.length} compatibility issues in ${allIssues.length} mods`);
      } else {
        // No issues found
        successMessage.set(`All mods compatible! Checked ${checkedCount} mods.`);
      }
    } catch (error) {
      errorMessage.set(`Failed to check compatibility: ${error.message}`);
    }
  }
  
  /**
   * Update all mods at once
   */
  async function updateAllMods() {
    // Get all mods with updates
    const modsWithUpdatesList = [];
    for (const [modName, updateInfo] of $modsWithUpdates.entries()) {
      // Skip entries that start with "project:" as they're duplicates
      if (modName.startsWith('project:')) continue;
      
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
    
    // Skip if no mods to update
    if (modsWithUpdatesList.length === 0) {
      return;
    }
    
    // Check for compatibility issues across all mods
    const allIssues = [];
    for (const mod of modsWithUpdatesList) {
      if (mod.version.dependencies && mod.version.dependencies.length > 0) {
        const issues = await checkDependencyCompatibility(mod.version.dependencies);
        if (issues.length > 0) {
          allIssues.push({
            mod: mod.modName,
            issues
          });
        }
      }
    }
    
    if (allIssues.length > 0) {
      // Show compatibility warning with all issues
      compatibilityWarnings = allIssues.flatMap(item => 
        item.issues.map(issue => ({
          ...issue,
          modName: item.mod
        }))
      );
      showCompatibilityWarning = true;
      modsToUpdate = modsWithUpdatesList;
      return;
    }
    
    // No issues, proceed with all updates
    updateAllInProgress = true;
    
    try {
      for (const mod of modsWithUpdatesList) {
        await proceedWithUpdate(mod.modName, mod.projectId, mod.versionId, mod.version);
      }
    } finally {
      updateAllInProgress = false;
    }
  }
  
  function handleCompatibilityWarning({ issues, modToUpdate }) {
    compatibilityWarnings = issues;
    modsToUpdate = modToUpdate ? [{ modName: modToUpdate.name, projectId: modToUpdate.id, versionId: modToUpdate.selectedVersionId, version: modToUpdate }] : [];
    showCompatibilityWarning = true;
  }

  /**
   * Proceed with updates after confirming compatibility warnings
   */
  function proceedWithUpdatesAnyway() {
    showCompatibilityWarning = false;
    
    // Process all the updates
    for (const mod of modsToUpdate) {
      proceedWithUpdate(mod.modName, mod.projectId, mod.versionId, mod.version);
    }
    
    // Reset state
    modsToUpdate = [];
    compatibilityWarnings = [];
  }
  
  function handleEnableDependencies() {
    groupDependencyWarnings(compatibilityWarnings).forEach(g => { if (g.type === "disabled") enableDependency(g.dependency); });
    showCompatibilityWarning = false;
    compatibilityWarnings = [];
    modsToUpdate = [];
  }

  function handleInstallDependencies() {
    const deps = groupDependencyWarnings(compatibilityWarnings).filter(g => g.type === "missing").map(g => ({ projectId: g.dependency?.projectId, name: g.dependency?.name || "Required Dependency", dependencyType: "required", requiredVersion: g.dependency?.versionRequirement }));
    if (deps.length > 0) {
      const modToUpdate = { id: deps[0].projectId, name: deps[0].name, selectedVersionId: null };
      dispatch("install-dependencies", { mod: modToUpdate, dependencies: deps });
    }
    showCompatibilityWarning = false;
    compatibilityWarnings = [];
    modsToUpdate = [];
  }

  function handleFixAll() {
    handleEnableDependencies();
    handleInstallDependencies();
  }

  /** Toggle selection of a mod for bulk actions */
  function toggleSelectMod(modName) {
    if (selectedMods.has(modName)) {
      selectedMods.delete(modName);
    } else {
      selectedMods.add(modName);
    }
    selectedMods = new Set(selectedMods);
  }
  
  /** Delete all selected mods */
  async function deleteSelectedMods() {
    if (selectedMods.size === 0) return;
    for (const modName of selectedMods) {
      await deleteMod(modName, serverPath, false);
    }
    selectedMods = new Set();
    await loadMods(serverPath);
  }
  
  /** Disable all selected mods */
  async function disableSelectedMods() {
    if (selectedMods.size === 0) return;
    selectedMods.forEach(modName => {
      disabledMods.update(mods => {
        const newMods = new Set(mods);
        newMods.add(modName);
        return newMods;
      });
    });
    selectedMods = new Set();
    await safeInvoke('save-disabled-mods', serverPath, Array.from($disabledMods));
    await loadMods(serverPath);
  }
  
  /** Delete all selected disabled mods */
  async function deleteSelectedDisabledMods() {
    if (selectedDisabledMods.size === 0) return;
    for (const modName of selectedDisabledMods) {
      await deleteMod(modName, serverPath, false);
    }
    selectedDisabledMods = new Set();
    await loadMods(serverPath);
  }
  
  /** Enable all selected disabled mods */
  async function enableSelectedDisabledMods() {
    if (selectedDisabledMods.size === 0) return;
    selectedDisabledMods.forEach(modName => {
      disabledMods.update(mods => {
        const newMods = new Set(mods);
        newMods.delete(modName);
        return newMods;
      });
    });
    selectedDisabledMods = new Set();
    await safeInvoke('save-disabled-mods', serverPath, Array.from($disabledMods));
    await loadMods(serverPath);
  }
  
  /** Toggle selection of a disabled mod for bulk actions */
  function toggleSelectDisabledMod(modName) {
    if (selectedDisabledMods.has(modName)) {
      selectedDisabledMods.delete(modName);
    } else {
      selectedDisabledMods.add(modName);
    }
    selectedDisabledMods = new Set(selectedDisabledMods);
  }
  
  /** Show bulk delete confirmation for installed mods */
  function showBulkDeleteConfirmation() { confirmBulkDeleteVisible = true; }
  /** Show bulk disable confirmation for installed mods */
  function showBulkDisableConfirmation() { confirmBulkDisableVisible = true; }
  /** Show bulk delete confirmation for disabled mods */
  function showBulkDeleteDisabledConfirmation() { confirmBulkDeleteDisabledVisible = true; }
  /** Show bulk enable confirmation for disabled mods */
  function showBulkEnableDisabledConfirmation() { confirmBulkEnableDisabledVisible = true; }
  
  /** Confirm and execute bulk delete for installed mods */
  async function confirmBulkDelete() {
    confirmBulkDeleteVisible = false;
    await deleteSelectedMods();
  }
  /** Confirm and execute bulk disable for installed mods */
  async function confirmBulkDisable() {
    confirmBulkDisableVisible = false;
    await disableSelectedMods();
  }
  /** Confirm and execute bulk delete for disabled mods */
  async function confirmBulkDeleteDisabled() {
    confirmBulkDeleteDisabledVisible = false;
    await deleteSelectedDisabledMods();
  }
  /** Confirm and execute bulk enable for disabled mods */
  async function confirmBulkEnableDisabled() {
    confirmBulkEnableDisabledVisible = false;
    await enableSelectedDisabledMods();
  }
  
  // Bulk toggle all installed mods selection
  function toggleSelectAllInstalledMods(event) {
    const all = event.target.checked;
    if (all) {
      selectedMods = new Set($installedMods.filter(mod => !$disabledMods.has(mod)));
    } else {
      selectedMods = new Set();
    }
  }
  
  // Bulk toggle all disabled mods selection
  function toggleSelectAllDisabledMods(event) {
    const all = event.target.checked;
    const disabledList = Array.from($disabledMods).filter(mod => $installedMods.includes(mod));
    if (all) {
      selectedDisabledMods = new Set(disabledList);
    } else {
      selectedDisabledMods = new Set();
    }
  }
  
  // Load mods on mount and check for updates
  onMount(() => {
    // Load initial data
    loadMods(serverPath);
    checkForUpdates(serverPath);
    
    // Set up an interval to check for updates every 5 minutes
    const updateInterval = setInterval(() => {
      if (!get(isCheckingUpdates)) {
        checkForUpdates(serverPath);
      }
    }, 5 * 60 * 1000);
    
    // Listen for download progress events
    // @ts-ignore - TypeScript doesn't know about our Electron preload interfaces
    if (typeof window !== 'undefined' && window.ipcRenderer) {
      // @ts-ignore - TypeScript doesn't know about our Electron preload interfaces
      downloadListener = window.ipcRenderer.on('download-progress', (event, data) => {
        if (!data) return;
        
        // Find mod by name in our list
        const mod = $installedMods.find(m => m.includes(data.name) || data.name.includes(m));
        if (!mod) return;
        
        // Handle based on progress state
        if (data.error) {
          // Download error
          for (const statusKey of [...modStatus.keys()]) {
            if (statusKey.startsWith(`${mod}:`)) {
              modStatus.set(statusKey, "error");
            }
          }
          modStatus = new Map(modStatus); // Force reactivity update
          
          // Clear error status after a delay
          setTimeout(() => {
            for (const statusKey of [...modStatus.keys()]) {
              if (statusKey.startsWith(`${mod}:`)) {
                modStatus.delete(statusKey);
              }
            }
            modStatus = new Map(modStatus); // Force reactivity update
          }, 3000);
        } else if (data.completed) {
          // Download completed
          for (const statusKey of [...modStatus.keys()]) {
            if (statusKey.startsWith(`${mod}:`) && modStatus.get(statusKey) === "updating") {
              // Set success state briefly
              modStatus.set(statusKey, "success");
              modStatus = new Map(modStatus); // Force reactivity update
              
              // Remove from updates list
              modsWithUpdates.update(updates => {
                updates.delete(mod);
                return updates;
              });
              
              // Clear all status indicators for this mod after a delay
              setTimeout(() => {
                clearModStatus(mod);
                
                // Refresh the mod info to show the updated version
                dispatch('refresh');
              }, 2000);
            }
          }
        } else {
          // Still downloading
          for (const statusKey of [...modStatus.keys()]) {
            if (statusKey.startsWith(`${mod}:`) && modStatus.get(statusKey) !== "updating") {
              modStatus.set(statusKey, "updating");
              modStatus = new Map(modStatus); // Force reactivity update
            }
          }
        }
      });
    }
    
    // Load disabled mods
    try {
      safeInvoke('get-disabled-mods', serverPath).then(disabledModsList => {
        if (Array.isArray(disabledModsList)) {
          disabledMods.set(new Set(disabledModsList));
        }
      });
    } catch (error) {
      console.error('Failed to load disabled mods:', error);
    }
    
    // Clean up the interval when the component is destroyed
    return () => {
      clearInterval(updateInterval);
      // Clean up listener
      // @ts-ignore - TypeScript doesn't know about our Electron preload interfaces
      if (downloadListener && typeof window !== 'undefined' && window.ipcRenderer) {
        // @ts-ignore - TypeScript doesn't know about our Electron preload interfaces
        window.ipcRenderer.removeListener('download-progress', downloadListener);
      }
    };
  });

  onDestroy(() => {
    // Clean up listener
    // @ts-ignore - TypeScript doesn't know about our Electron preload interfaces
    if (downloadListener && typeof window !== 'undefined' && window.ipcRenderer) {
      // @ts-ignore - TypeScript doesn't know about our Electron preload interfaces
      window.ipcRenderer.removeListener('download-progress', downloadListener);
    }
  });

  async function enableDependency(dependency) {
    // Remove the dependency from the disabledMods store
    disabledMods.update(mods => {
      const newMods = new Set(mods);
      // Find the installed mod by projectId to get the fileName
      const mod = $installedModInfo.find(m => m.projectId === dependency.projectId);
      if (mod) {
        newMods.delete(mod.fileName);
      }
      return newMods;
    });
    // Persist the change and reload mods
    const mod = $installedModInfo.find(m => m.projectId === dependency.projectId);
    if (mod) {
      await safeInvoke('save-disabled-mods', serverPath, Array.from($disabledMods));
      await loadMods(serverPath);
    }
  }

  // Group compatibility warnings by dependency projectId
  function groupDependencyWarnings(warnings) {
    const grouped = {};
    for (const warning of warnings) {
      const depId = warning.dependency?.projectId;
      if (!depId) continue;
      if (!grouped[depId]) {
        grouped[depId] = {
          dependency: warning.dependency,
          type: warning.type,
          mods: [],
          warningObjs: []
        };
      }
      grouped[depId].mods.push(warning.modName);
      grouped[depId].warningObjs.push(warning);
      // If any warning for this dep is 'missing', set type to 'missing' (highest priority)
      if (warning.type === 'missing') grouped[depId].type = 'missing';
      else if (warning.type === 'disabled' && grouped[depId].type !== 'missing') grouped[depId].type = 'disabled';
      else if (warning.type === 'version_mismatch' && !['missing','disabled'].includes(grouped[depId].type)) grouped[depId].type = 'version_mismatch';
      else if (warning.type === 'update_available' && !['missing','disabled','version_mismatch'].includes(grouped[depId].type)) grouped[depId].type = 'update_available';
    }
    return Object.values(grouped);
  }

  /**
   * Handle category change for a mod
   * @param {Object} mod - The mod object to update
   * @param {Event} event - The change event from the select element
   */
  async function handleCategoryChange(mod, event) {
    try {
      const select = event.target;
      if (!(select instanceof HTMLSelectElement)) {
        return;
      }

      const newCategory = select.value;
      const fileName = typeof mod === 'string' ? mod : mod.fileName;
      
      console.log(`Updating category for ${fileName} to ${newCategory}`);
      
      // First, update the category in the store
      await updateModCategory(fileName, newCategory);
      
      // Now, update the file locations through IPC
      const result = await safeInvoke('move-mod-file', {
        fileName, 
        newCategory,
        serverPath
      });
      
      if (result && result.success) {
        successMessage.set(`Changed ${fileName} to "${newCategory}"`);
      } else {
        throw new Error(result?.error || 'Unknown error occurred');
      }
      
      // Reload mods list to update UI without navigating away
      await loadMods(serverPath);
    } catch (err) {
      console.error('Error updating mod category:', err);
      errorMessage.set(`Failed to update mod category: ${err.message}`);
    }
  }
  
  async function handleRequirementChange(mod, event) {
    try {
      const checkbox = event.target;
      if (!(checkbox instanceof HTMLInputElement)) {
        return;
      }
      
      const required = checkbox.checked;
      const fileName = typeof mod === 'string' ? mod : mod.fileName;
      
      console.log(`Updating requirement for ${fileName} to ${required}`);
      
      // Update the required status in the store
      await updateModRequired(fileName, required);
      
      successMessage.set(`${fileName} is now ${required ? 'required' : 'optional'} for clients`);
    } catch (err) {
      console.error('Error updating mod requirement:', err);
      errorMessage.set(`Failed to update mod requirement: ${err.message}`);
    }
  }
  
  // Update a mod's required status
  async function handleUpdateRequired(mod, required) {
    try {
      await updateModRequired(mod.fileName, required);
      successMessage.set(`${mod.title} is now ${required ? 'required' : 'optional'}`);
    } catch (error) {
      errorMessage.set(`Failed to update mod requirement: ${error.message}`);
    }
  }
</script>

<div class="installed-mods-section">
  <!-- Mod list header with filters -->
  <div class="mod-list-header">
    <div class="header-left">
      <h2>Installed Mods</h2>
    </div>
    <div class="header-actions">
      <button class="action-button" on:click={handleCheckUpdates}>
        {$isCheckingUpdates ? 'Checking...' : 'Check for Updates'}
      </button>
      <button class="action-button" on:click={checkAllModsCompatibility}>
        Check Compatibility
      </button>
      {#if $updateCount > 0}
          <button
          class="action-button update-all-button"
            on:click={updateAllMods}
          disabled={updateAllInProgress}
        >
          {updateAllInProgress ? 'Updating...' : `Update All (${$updateCount})`}
          </button>
        {/if}
      {#if selectedMods.size > 0}
        <div class="bulk-actions">
          <button class="action-button delete-selected" on:click={showBulkDeleteConfirmation} disabled={$serverState.status === 'Running'}>
          {#if $serverState.status === 'Running'}<span class="lock-icon">🔒</span>{/if} Delete Selected ({selectedMods.size})
        </button>
          <button class="action-button disable-selected" on:click={showBulkDisableConfirmation} disabled={$serverState.status === 'Running'}>
          {#if $serverState.status === 'Running'}<span class="lock-icon">🔒</span>{/if} Disable Selected ({selectedMods.size})
        </button>
      </div>
      {/if}
    </div>
  </div>
  
  <div class="mods-list">
    {#if $installedMods.length === 0}
      <div class="no-mods">No mods installed</div>
    {:else}
      <div class="grid-header">
        <div class="header-cell select-cell">
          <input type="checkbox"
            checked={selectedMods.size === $installedMods.filter(mod => !$disabledMods.has(mod)).length}
            on:change={toggleSelectAllInstalledMods}
          />
        </div>
        <div class="header-cell">Mod Name</div>
        <div class="header-cell">Location</div>
        <div class="header-cell">Current Version</div>
        <div class="header-cell">Available Update</div>
        <div class="header-cell">Actions</div>
  
        </div>
      <div class="mods-grid">
        {#each $installedMods.filter(mod => !$disabledMods.has(mod)) as mod}
          <ModRow {mod} {installedModVersionsCache} {modStatus} selected={selectedMods.has(mod)} on:toggleSelect={toggleSelectMod} on:delete={showDeleteConfirmation} on:toggleDisable={(e) => showDisableConfirmation(e.detail.mod, e.detail.disabled)} on:updateMod={(e) => dispatch("updateMod", e.detail)} on:compatibility-warning={(e) => handleCompatibilityWarning(e.detail)} />
        {/each}
      </div>
      {/if}
  </div>

  <!-- Disabled Mods Section - Only shown if there are disabled mods -->
  {#if $disabledMods && $disabledMods.size > 0}
    <div class="disabled-mods-section">
      <div class="section-header">
        <h3>
          <span class="disabled-badge">{$disabledMods.size} Disabled Mod{$disabledMods.size > 1 ? 's' : ''}</span>
        </h3>
        <div class="header-actions">
          <div class="button-row">
            <button class="delete-button" on:click={showBulkDeleteDisabledConfirmation} disabled={$serverState.status === 'Running' || selectedDisabledMods.size === 0} title={$serverState.status === 'Running' ? 'Disabled while server is running' : 'Delete selected disabled mods'}>
              {#if $serverState.status === 'Running'}<span class="lock-icon">🔒</span>{/if} Delete Selected ({selectedDisabledMods.size})
            </button>
            <button class="enable-button" on:click={showBulkEnableDisabledConfirmation} disabled={$serverState.status === 'Running' || selectedDisabledMods.size === 0} title={$serverState.status === 'Running' ? 'Disabled while server is running' : 'Enable selected disabled mods'}>
              {#if $serverState.status === 'Running'}<span class="lock-icon">🔒</span>{/if} Enable Selected ({selectedDisabledMods.size})
            </button>
          </div>
        </div>
      </div>
      
      <div class="mods-list">
        <div class="grid-header">
          <div class="header-cell select-cell">
            <input type="checkbox"
              checked={selectedDisabledMods.size === Array.from($disabledMods).filter(mod => $installedMods.includes(mod)).length}
              on:change={toggleSelectAllDisabledMods}
            />
          </div>
          <div class="header-cell">Mod Name</div>
          <div class="header-cell">Current Version</div>
          <div class="header-cell">Available Update</div>
          <div class="header-cell">Actions</div>
        </div>
        <div class="mods-grid">
          {#each Array.from($disabledMods).filter(mod => $installedMods.includes(mod)) as mod}
            <ModRow {mod} {installedModVersionsCache} {modStatus} selected={selectedDisabledMods.has(mod)} disabled={true} on:toggleSelect={toggleSelectDisabledMod} on:delete={showDeleteConfirmation} on:toggleDisable={(e) => showDisableConfirmation(e.detail.mod, true)} on:updateMod={(e) => dispatch("updateMod", e.detail)} on:compatibility-warning={(e) => handleCompatibilityWarning(e.detail)} />
          {/each}
        </div>
      </div>
    </div>
  {/if}
  
  <!-- Delete Confirmation Dialog -->
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
  
  <!-- Disable/Enable Confirmation Dialog -->
  <ConfirmationDialog
    bind:visible={confirmDisableVisible}
    title={modToToggle && modToToggle.isDisabled ? "Enable Mod" : "Disable Mod"}
    message={modToToggle ? 
      (modToToggle.isDisabled ? 
        `Are you sure you want to enable ${modToToggle.name}?` : 
        `Are you sure you want to disable ${modToToggle.name}?`) : 
      'Are you sure you want to toggle this mod?'
    }
    confirmText={modToToggle && modToToggle.isDisabled ? "Enable" : "Disable"}
    cancelText="Cancel"
    confirmType="warning"
    on:confirm={confirmToggleModStatus}
    on:cancel={() => { confirmDisableVisible = false; }}
  />
  
  <CompatibilityWarningDialog
    bind:visible={showCompatibilityWarning}
    warnings={compatibilityWarnings}
    {modsToUpdate}
    on:close={() => { showCompatibilityWarning = false; modsToUpdate = []; compatibilityWarnings = []; }}
    on:proceed={proceedWithUpdatesAnyway}
    on:enable={handleEnableDependencies}
    on:install={handleInstallDependencies}
    on:fixAll={handleFixAll}
  />
  
  <!-- Bulk Delete Installed Mods Confirmation -->
  <ConfirmationDialog
    bind:visible={confirmBulkDeleteVisible}
    title="Delete Mods"
    message={`Are you sure you want to delete ${selectedMods.size} selected mod(s)?`}
    confirmText="Delete"
    cancelText="Cancel"
    confirmType="danger"
    on:confirm={confirmBulkDelete}
    on:cancel={() => { confirmBulkDeleteVisible = false; }}
  />
  
  <!-- Bulk Disable Installed Mods Confirmation -->
  <ConfirmationDialog
    bind:visible={confirmBulkDisableVisible}
    title="Disable Mods"
    message={`Are you sure you want to disable ${selectedMods.size} selected mod(s)?`}
    confirmText="Disable"
    cancelText="Cancel"
    confirmType="warning"
    on:confirm={confirmBulkDisable}
    on:cancel={() => { confirmBulkDisableVisible = false; }}
  />
  
  <!-- Bulk Delete Disabled Mods Confirmation -->
  <ConfirmationDialog
    bind:visible={confirmBulkDeleteDisabledVisible}
    title="Delete Disabled Mods"
    message={`Are you sure you want to delete ${selectedDisabledMods.size} selected disabled mod(s)?`}
    confirmText="Delete"
    cancelText="Cancel"
    confirmType="danger"
    on:confirm={confirmBulkDeleteDisabled}
    on:cancel={() => { confirmBulkDeleteDisabledVisible = false; }}
  />
  
  <!-- Bulk Enable Disabled Mods Confirmation -->
  <ConfirmationDialog
    bind:visible={confirmBulkEnableDisabledVisible}
    title="Enable Disabled Mods"
    message={`Are you sure you want to enable ${selectedDisabledMods.size} selected disabled mod(s)?`}
    confirmText="Enable"
    cancelText="Cancel"
    confirmType="warning"
    on:confirm={confirmBulkEnableDisabled}
    on:cancel={() => { confirmBulkEnableDisabledVisible = false; }}
  />
</div>

<style>
  /* global box-sizing to include borders in width calculations */
  :global(*), :global(*::before), :global(*::after) {
    box-sizing: border-box;
  }

  /* Custom Checkbox Styling */
  .select-cell input[type="checkbox"] {
    -webkit-appearance: none;
    -moz-appearance: none;
    appearance: none;
    width: 20px;
    height: 20px;
    border-radius: 4px;
    border: 2px solid rgba(255, 255, 255, 0.3);
    background: rgba(255, 255, 255, 0.1);
    cursor: pointer;
    position: relative;
    outline: none;
    transition: all 0.2s ease;
  }

  .select-cell input[type="checkbox"]:checked {
    background-color: #646cff;
    border-color: #646cff;
  }

  .select-cell input[type="checkbox"]:checked::after {
    content: "";
    position: absolute;
    top: 2px;
    left: 6px;
    width: 5px;
    height: 10px;
    border: solid white;
    border-width: 0 2px 2px 0;
    transform: rotate(45deg);
  }

  .select-cell input[type="checkbox"]:hover {
    border-color: rgba(255, 255, 255, 0.5);
  }

  .select-cell {
    display: flex;
    justify-content: center;
    align-items: center;
  }

  .installed-mods-section {
    margin-top: 2rem;
  }
  
  .section-header {
    display: flex;
    justify-content: space-between;
    align-items: center;
    margin-bottom: 1rem;
  }
  
  h3 {
    margin: 0;
    display: flex;
    align-items: center;
    gap: 0.5rem;
  }
  
  .header-actions {
    display: flex;
    gap: 0.5rem;
  }
  
  .refresh-button, .check-updates-button {
    background: rgba(255, 255, 255, 0.1);
    border: none;
    border-radius: 4px;
    width: 2rem;
    height: 2rem;
    display: flex;
    align-items: center;
    justify-content: center;
    cursor: pointer;
    transition: all 0.2s;
  }
  
  .refresh-button:hover, .check-updates-button:hover {
    background: rgba(255, 255, 255, 0.2);
  }
  
  .checking-updates {
    font-size: 0.8rem;
    font-style: italic;
    color: #ffa500;
    font-weight: normal;
  }
  
  .updates-badge {
    font-size: 0.8rem;
    background-color: #4caf50;
    color: white;
    padding: 0.2rem 0.5rem;
    border-radius: 10px;
    font-weight: normal;
  }
  
  .disabled-badge {
    font-size: 0.8rem;
    background-color: #ff9800;
    color: white;
    padding: 0.2rem 0.5rem;
    border-radius: 10px;
    font-weight: normal;
  }
  
  .mods-list {
    background: rgba(0, 0, 0, 0.2);
    border-radius: 8px;
    padding: 0.5rem;
  }
  
  .grid-header {
    display: grid;
    grid-template-columns: auto 2fr 1fr 1fr auto;
    border-left: 1px solid transparent;
    padding: 0.75rem 1rem;
    margin-bottom: 0.5rem;
  }
  
  .header-cell {
    font-weight: 500;
    color: rgba(255, 255, 255, 0.7);
    font-size: 0.9rem;
    text-align: center;
  }
  
  .header-cell:first-child {
    text-align: left;
  }
  
  .header-cell:last-child {
    text-align: right;
  }
  
  .grid-header .header-cell:nth-child(1) {
    text-align: center;
  }
  .grid-header .header-cell:nth-child(2) {
    text-align: left;
  }
  .grid-header .header-cell:nth-child(3),
  .grid-header .header-cell:nth-child(4) {
    text-align: center;
  }
  .grid-header .header-cell:nth-child(5) {
    text-align: right;
  }
  
  .mods-grid {
    display: flex;
    flex-direction: column;
    gap: 0.75rem;
  }
  
  .no-mods {
    text-align: center;
    padding: 2rem;
    color: rgba(255, 255, 255, 0.5);
    font-style: italic;
  }
  
  .mod-card {
    background: rgba(255, 255, 255, 0.07);
    border-radius: 8px;
    overflow: hidden;
    box-shadow: 0 2px 4px rgba(0, 0, 0, 0.2);
    border: 1px solid rgba(255, 255, 255, 0.1);
    transition: all 0.2s ease;
  }
  
  .mod-card:hover {
    transform: translateY(-2px);
    box-shadow: 0 4px 8px rgba(0, 0, 0, 0.3);
    border-color: rgba(255, 255, 255, 0.2);
  }
  
  .mod-card.expanded {
    box-shadow: 0 2px 8px rgba(0, 0, 0, 0.2);
  }
  
  .mod-card.disabled {
    background: rgba(255, 255, 255, 0.05);
    border-left: 3px solid #ff9800;
    opacity: 0.8;
  }
  
  .disabled-tag {
    font-size: 0.8rem;
    background-color: rgba(255, 152, 0, 0.2);
    color: #ffae42;
    padding: 0.1rem 0.4rem;
    border-radius: 4px;
    font-weight: 500;
  }
  
  .mod-item-header-container {
    display: grid;
    grid-template-columns: auto 2fr 1fr 1fr auto;
    align-items: center;
    padding: 0.75rem 1rem;
  }
  
  .mod-item-header-container .select-cell {
    justify-self: center;
  }
  
  .mod-item-header-container .mod-info {
    justify-self: start;
  }
  
  .mod-item-header-container .mod-version-column {
    justify-self: center;
  }
  
  .mod-item-header-container .mod-update-column {
    justify-self: center;
  }
  
  .mod-item-header-container .mod-actions {
    justify-self: end;
  }
  
  .mod-info {
    display: flex;
    flex-direction: column;
    gap: 0.25rem;
  }
  
  .mod-name {
    font-weight: 600;
    white-space: nowrap;
    overflow: hidden;
    text-overflow: ellipsis;
    max-width: 200px;
    color: rgba(255, 255, 255, 1);
    font-size: 1rem;
    text-shadow: 0px 1px 2px rgba(0, 0, 0, 0.3);
  }

  .mod-category-container {
    display: flex;
    flex-direction: column;
    gap: 0.25rem;
    margin-top: 0.5rem;
  }

  .mod-category-select {
    padding: 0.25rem;
    background: rgba(255, 255, 255, 0.1);
    border: 1px solid rgba(255, 255, 255, 0.2);
    border-radius: 4px;
    color: white;
    font-size: 0.85rem;
    width: auto;
    cursor: pointer;
  }

  .mod-category-select:hover:not(:disabled) {
    background: rgba(255, 255, 255, 0.15);
  }

  .mod-category-select:disabled {
    opacity: 0.6;
    cursor: not-allowed;
  }

  .mod-required-checkbox {
    margin-top: 0.25rem;
    font-size: 0.85rem;
    color: rgba(255, 255, 255, 0.9);
  }

  .mod-required-checkbox label {
    display: flex;
    align-items: center;
    gap: 0.5rem;
    cursor: pointer;
  }

  .mod-required-checkbox input[type="checkbox"] {
    cursor: pointer;
  }

  .mod-required-checkbox input[type="checkbox"]:disabled {
    cursor: not-allowed;
    opacity: 0.6;
  }
  
  .mod-version-column, 
  .mod-update-column {
    display: flex;
    flex-direction: column;
    align-items: center;
    justify-content: center;
    text-align: center;
    gap: 0.25rem;
  }
  
  .update-container {
    display: flex;
    flex-direction: column;
    align-items: center;
    gap: 0.5rem;
    width: 100%;
    padding: 0.25rem;
  }
  
  .version-tag, .mc-version-tag {
    background: rgba(100, 108, 255, 0.2);
    color: #a0a8ff;
    padding: 0.1rem 0.4rem;
    border-radius: 4px;
    font-size: 0.8rem;
    max-width: 100%;
    overflow: hidden;
    text-overflow: ellipsis;
    white-space: nowrap;
  }
  
  .version-tag.current-version {
    background: rgba(76, 175, 80, 0.2);
    color: #66bb6a;
    font-weight: 500;
  }
  
  .version-tag.new-version {
    background: rgba(255, 152, 0, 0.2);
    color: #ffae42;
    font-weight: 500;
    margin-bottom: 0.25rem;
    padding: 0.2rem 0.6rem;
  }
  
  .mc-version-tag {
    background: rgba(255, 152, 0, 0.2);
    color: #ffae42;
  }
  
  .up-to-date {
    font-size: 0.85rem;
    color: rgba(255, 255, 255, 0.6);
    font-style: italic;
    height: 100%;
    display: flex;
    align-items: center;
    justify-content: center;
  }
  
  .mod-actions {
    display: flex;
    flex-direction: column;
    align-items: center;
    gap: 0.5rem;
  }
  
  .delete-button, .update-button, .disable-button, .enable-button, .update-all-button {
    padding: 0.35rem 0.75rem;
    border: none;
    border-radius: 6px;
    font-size: 0.8rem;
    cursor: pointer;
    transition: all 0.2s;
  }
  
  .delete-button {
    background: rgba(244, 67, 54, 0.2);
    color: #ff6b6b;
    width: 100%;
    text-align: center;
  }
  
  .delete-button:hover {
    background: rgba(244, 67, 54, 0.3);
  }

  .bulk-actions {
    display: flex;
    gap: 0.5rem;
    margin-left: 0.5rem;
  }

  .delete-selected, .disable-selected {
    padding: 0.35rem 0.75rem;
    border: none;
    border-radius: 6px;
    font-size: 0.8rem;
    cursor: pointer;
    transition: all 0.2s;
    white-space: nowrap;
  }

  .delete-selected {
    background: rgba(244, 67, 54, 0.2);
    color: #ff6b6b;
    font-weight: 500;
  }

  .delete-selected:hover:not(:disabled) {
    background: rgba(244, 67, 54, 0.3);
  }

  .disable-selected {
    background: rgba(255, 152, 0, 0.2);
    color: #ffae42;
    font-weight: 500;
  }

  .disable-selected:hover:not(:disabled) {
    background: rgba(255, 152, 0, 0.3);
  }
  
  .update-button {
    background: #1bd96a;
    color: #000;
    font-weight: 600;
    padding: 0.35rem 0.75rem;
    border-radius: 6px;
    border: none;
    cursor: pointer;
    transition: all 0.2s;
    white-space: nowrap;
    width: 100%;
    text-align: center;
  }
  
  .update-button:hover {
    background: #0ec258;
    transform: translateY(-1px);
  }
  
  .update-all-button {
    background: #1bd96a;
    color: #000;
    font-weight: 600;
    padding: 0.35rem 0.75rem;
    border-radius: 6px;
    border: none;
    cursor: pointer;
    transition: all 0.2s;
    white-space: nowrap;
  }
  
  .update-all-button:hover {
    background: #0ec258;
    transform: translateY(-1px);
  }
  
  .update-all-button:disabled {
    background: #1bd96a88;
    cursor: not-allowed;
    transform: none;
  }
  
  .disable-button {
    background: rgba(255, 152, 0, 0.2);
    color: #ffae42;
    border-radius: 6px;
    width: 100%;
    text-align: center;
  }
  
  .disable-button:hover {
    background: rgba(255, 152, 0, 0.3);
  }
  
  .enable-button {
    background: rgba(76, 175, 80, 0.2);
    color: #66bb6a;
    border-radius: 6px;
    width: 100%;
    text-align: center;
  }
  
  .enable-button:hover {
    background: rgba(76, 175, 80, 0.3);
  }
  
  .version-toggle-button {
    background: rgba(255, 255, 255, 0.1);
    border: none;
    border-radius: 4px;
    width: 2rem;
    height: 2rem;
    display: flex;
    align-items: center;
    justify-content: center;
    cursor: pointer;
    transition: all 0.2s;
    align-self: center;
  }
  
  .version-toggle-button:hover {
    background: rgba(255, 255, 255, 0.2);
  }
  
  .version-toggle-icon {
    font-size: 0.7rem;
    color: rgba(255, 255, 255, 0.7);
  }
  
  .installed-mod-versions {
    padding: 0.75rem;
    background: rgba(0, 0, 0, 0.3);
    border-top: 1px solid rgba(255, 255, 255, 0.1);
    width: 100%;
    box-sizing: border-box;
  }
  
  .loading-versions, .no-versions, .no-version-info {
    text-align: center;
    padding: 1rem;
    color: rgba(255, 255, 255, 0.7);
    font-size: 0.9rem;
  }
  
  .mod-versions {
    display: flex;
    flex-direction: column;
    gap: 0.5rem;
    width: 100%;
  }
  
  .mod-version-item {
    display: flex;
    justify-content: space-between;
    align-items: center;
    padding: 0.75rem;
    background: rgba(255, 255, 255, 0.05);
    border-radius: 4px;
    text-align: left;
    width: 100%;
    box-sizing: border-box;
    border: none;
    color: inherit;
    font-family: inherit;
    font-size: inherit;
    transition: background-color 0.15s;
  }
  
  .mod-version-item:hover {
    background: rgba(255, 255, 255, 0.1);
  }
  
  .mod-version-item.current {
    background: rgba(100, 108, 255, 0.2);
    border-left: 3px solid #646cff;
  }
  
  .version-info {
    display: flex;
    flex-direction: column;
    gap: 4px;
    max-width: 70%;
    overflow: hidden;
    text-overflow: ellipsis;
  }
  
  .version-number {
    font-weight: 500;
    font-size: 14px;
    color: rgba(255, 255, 255, 0.9);
    white-space: nowrap;
    overflow: hidden;
    text-overflow: ellipsis;
  }
  
  .version-status {
    color: #4caf50;
    font-weight: 500;
  }
  
  .version-controls {
    display: flex;
    gap: 0.5rem;
    align-items: center;
  }
  
  .select-version {
    white-space: nowrap;
    padding: 4px 12px;
    font-size: 13px;
    border-radius: 4px;
    border: none;
    background: #646cff;
    color: white;
    cursor: pointer;
    transition: all 0.2s;
  }
  
  .select-version:hover {
    background: #7a81ff;
  }
  
  .mod-status {
    width: 1rem;
    height: 1rem;
    border-radius: 50%;
    background-color: rgba(255, 255, 255, 0.2);
  }
  
  .mod-status.updating {
    background-color: #ffa726;
    animation: pulse 1.5s infinite;
  }
  
  .mod-status.success {
    background-color: #66bb6a;
  }
  
  .mod-status.error {
    background-color: #ff6b6b;
  }
  
  .compatibility-badge {
    padding: 0.1rem 0.4rem;
    border-radius: 4px;
    font-size: 0.8rem;
  }
  
  .compatibility-badge.compatible {
    background-color: rgba(76, 175, 80, 0.1);
    border: 1px solid rgba(76, 175, 80, 0.3);
    color: rgba(76, 175, 80, 0.9);
  }
  
  /* Compatibility warning dialog */
  .compatibility-warning-overlay {
    position: fixed;
    top: 0;
    left: 0;
    right: 0;
    bottom: 0;
    background: rgba(0, 0, 0, 0.7);
    display: flex;
    align-items: center;
    justify-content: center;
    z-index: 1000;
  }
  
  .compatibility-warning-dialog {
    background: #2a2a2a;
    border-radius: 8px;
    box-shadow: 0 4px 12px rgba(0, 0, 0, 0.4);
    width: 90%;
    max-width: 600px;
    max-height: 80vh;
    padding: 1.5rem;
    display: flex;
    flex-direction: column;
    gap: 1rem;
  }
  
  .compatibility-warning-dialog h3 {
    color: #ff9800;
    margin: 0;
    text-align: center;
    font-size: 1.2rem;
  }
  
  .compatibility-warning-dialog h4 {
    color: rgba(255, 255, 255, 0.9);
    margin: 1rem 0 0.5rem 0;
    font-size: 1rem;
    border-bottom: 1px solid rgba(255, 255, 255, 0.1);
    padding-bottom: 0.25rem;
  }
  
  .warnings-container {
    max-height: 50vh;
    overflow-y: auto;
    background: rgba(0, 0, 0, 0.2);
    border-radius: 4px;
    padding: 1rem;
  }
  
  .warning-item {
    margin-bottom: 1rem;
    padding-bottom: 1rem;
    border-bottom: 1px solid rgba(255, 255, 255, 0.1);
    position: relative;
  }
  
  .warning-item:last-child {
    margin-bottom: 0;
    padding-bottom: 0;
    border-bottom: none;
  }
  
  .warning-item.missing {
    border-left: 3px solid #f44336;
    padding-left: 0.5rem;
  }
  
  .warning-item.version-mismatch {
    border-left: 3px solid #ff9800; 
    padding-left: 0.5rem;
  }
  
  .warning-item.update {
    border-left: 3px solid #4caf50;
    padding-left: 0.5rem;
  }
  
  .warning-item.disabled {
    border-left: 3px solid #ff9800;
    padding-left: 0.5rem;
  }
  
  .warning-badge {
    position: absolute;
    top: 0;
    right: 0;
    font-size: 0.7rem;
    padding: 0.1rem 0.3rem;
    border-radius: 3px;
    text-transform: uppercase;
  }
  
  .warning-item.missing .warning-badge {
    background: rgba(244, 67, 54, 0.2);
    color: #ff6b6b;
  }
  
  .warning-item.version-mismatch .warning-badge {
    background: rgba(255, 152, 0, 0.2);
    color: #ffae42;
  }
  
  .warning-item.update .warning-badge {
    background: rgba(76, 175, 80, 0.2);
    color: #66bb6a;
  }
  
  .warning-item.disabled .warning-badge {
    background: rgba(255, 152, 0, 0.2);
    color: #ffae42;
  }
  
  .version-detail {
    display: flex;
    justify-content: space-between;
    margin-top: 0.5rem;
    font-size: 0.85rem;
  }
  
  .warning-message {
    color: rgba(255, 255, 255, 0.9);
    line-height: 1.4;
  }
  
  .warning-actions {
    display: flex;
    justify-content: flex-end;
    gap: 0.5rem;
    margin-top: 1rem;
  }
  
  .warning-cancel, .warning-proceed, .warning-install {
    padding: 0.5rem 1rem;
    border-radius: 4px;
    border: none;
    font-weight: 500;
    cursor: pointer;
  }
  
  .warning-cancel {
    background: rgba(255, 255, 255, 0.1);
    color: #fff;
  }
  
  .warning-proceed {
    background: #ff9800;
    color: #fff;
  }
  
  .warning-install {
    background: #4caf50;
    color: #fff;
  }
  
  .warning-cancel:hover {
    background: rgba(255, 255, 255, 0.2);
  }
  
  .warning-proceed:hover {
    background: #f57c00;
  }
  
  .warning-install:hover {
    background: #388e3c;
  }
  
  @keyframes pulse {
    0% { opacity: 0.5; }
    50% { opacity: 1; }
    100% { opacity: 0.5; }
  }
  
  .loading-spinner {
    display: inline-block;
    animation: spin 1.5s linear infinite;
  }
  
  @keyframes spin {
    0% { transform: rotate(0deg); }
    100% { transform: rotate(360deg); }
  }
  
  .button-row {
    display: flex;
    gap: 0.5rem;
    align-items: center;
    width: 100%;
  }
  
  .button-row .delete-button,
  .button-row .disable-button,
  .button-row .enable-button {
    flex: 1;
  }
  
  .disabled-mods-section {
    margin-top: 2rem;
  }
  
  .check-updates-button:hover:not(:disabled) {
    background: rgba(255, 255, 255, 0.3);
  }
  
  .check-compatibility-button {
    display: flex;
    justify-content: center;
    align-items: center;
    width: 2rem;
    height: 2rem;
    background: rgba(255, 255, 255, 0.1);
    border: none;
    border-radius: 4px;
    cursor: pointer;
    transition: all 0.2s;
    font-size: 1rem;
  }
  
  .check-compatibility-button:hover {
    background: rgba(255, 255, 255, 0.3);
  }
  
  /* Make header-actions buttons fit content */
  .header-actions .delete-button,
  .header-actions .disable-button,
  .header-actions .enable-button {
    width: auto;
    flex: none;
  }
  
  /* Align header-cell content precisely over columns */
  .grid-header .header-cell.select-cell {
    justify-self: center;
  }
  .grid-header .header-cell:nth-child(2) {
    justify-self: start;
  }
  .grid-header .header-cell:nth-child(3),
  .grid-header .header-cell:nth-child(4) {
    justify-self: center;
  }
  .grid-header .header-cell:nth-child(5) {
    justify-self: end;
  }
  
  /* Ensure mod-item header cells line up by column position */
  .mod-item-header-container > *:nth-child(1) {
    justify-self: center;
  }
  .mod-item-header-container > *:nth-child(2) {
    justify-self: start;
  }
  .mod-item-header-container > *:nth-child(3),
  .mod-item-header-container > *:nth-child(4) {
    justify-self: center;
  }
  .mod-item-header-container > *:nth-child(5) {
    justify-self: end;
  }

  .required-by {
    font-size: 0.85rem;
    color: #ffae42;
    margin-top: 0.25rem;
    margin-bottom: 0.25rem;
  }

  .lock-icon { margin-right: 0.3em; }

  .mod-action-button:disabled, .delete-button:disabled, .disable-button:disabled, .enable-button:disabled, .update-button:disabled, .select-version:disabled {
    background: #444 !important;
    color: #aaa !important;
    cursor: not-allowed !important;
    opacity: 0.7;
    text-decoration: line-through;
  }

  .mod-location-column {
    flex: 0 0 80px;
    display: flex;
    align-items: center;
    justify-content: center;
  }
  
  .location-tag {
    padding: 4px 8px;
    border-radius: 12px;
    font-size: 0.8rem;
    font-weight: 500;
    text-align: center;
    white-space: nowrap;
  }
  
  .server-tag {
    background-color: #6c7ae0;
    color: white;
  }
  
  .client-tag {
    background-color: #50c878;
    color: white;
  }
  
  .both-tag {
    background-color: #ffa500;
    color: white;
  }
  
  /* Add category-based coloring to mod cards */
  .mod-card.server-only {
    border-left: 3px solid #6c7ae0;
  }
  
  .mod-card.client-only {
    border-left: 3px solid #50c878;
  }
  
  .mod-card.both {
    border-left: 3px solid #ffa500;
  }
</style> 