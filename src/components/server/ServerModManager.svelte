<script>
  import { onMount, onDestroy } from 'svelte';
  import { get } from 'svelte/store';
  import { createEventDispatcher } from 'svelte';
  import { safeInvoke } from '../../utils/ipcUtils.js';
  // Import stores
  import { 
    installingModIds,
    searchResults,
    successMessage, 
    errorMessage,
    minecraftVersion,
    loaderType,
    totalPages,
    totalResults,
    isLoading,
    isSearching,
    filterMinecraftVersion,
    filterModLoader,
    expandedInstalledMod,
    modsWithUpdates,
    currentDependencies,
    modToInstall
  } from '../../stores/modStore.js';
    // Import components
import ModSearch from '../mods/components/ModSearch.svelte';
import InstalledModList from '../mods/components/InstalledModList.svelte';
import StatusManager from '../common/StatusManager.svelte';
import ModDependencyModal from '../mods/components/ModDependencyModal.svelte';
import DownloadProgress from '../mods/components/DownloadProgress.svelte';
    // Import API utilities
  import { 
    loadMods, 
    searchMods,
    loadServerConfig,
    installMod,
    checkForUpdates
  } from '../../utils/mods/modAPI.js';
  import { 
    installWithDependencies,
    checkModDependencies,
    showDependencyModal
  } from '../../utils/mods/modDependencyHelper.js';
  import { initDownloadManager } from '../../utils/mods/modDownloadManager.js';

  
  // Import utility for checking compatibility
  import { checkDependencyCompatibility } from '../../utils/mods/modCompatibility.js';
  
  // Props
  export let serverPath = '';
  
  // Local state
  let minecraftVersionOptions = [$minecraftVersion];
  let filterType = 'all';
  let downloadManagerCleanup;
  let activeTab = 'installed'; // 'installed' or 'search' or 'categories'
  
  // Initialize filter stores
  $: if ($minecraftVersion && $filterMinecraftVersion === '') {
    filterMinecraftVersion.set($minecraftVersion);
  }
  $: if ($loaderType && $filterModLoader === '') {
    filterModLoader.set($loaderType);
  }
  
  // Event dispatcher
  const dispatch = createEventDispatcher();
  
  // Initialize component
  onMount(() => {
    const initAsync = async () => {
      if (!serverPath) {
        try {          const pathResult = window.serverPath ? await window.serverPath.get() : null;
          // The result could be either { path: '...' } or just the path string
          if (pathResult !== null && pathResult !== undefined) {
            if (typeof pathResult === 'object' && pathResult && 'path' in pathResult) {
              serverPath = pathResult['path'] || '';
            } else if (typeof pathResult === 'string') {
              serverPath = pathResult;
            } else {
              serverPath = '';
            }
          } else {
            serverPath = '';
          }
        } catch (err) {
          serverPath = '';
        }
      }
      
      // Initialize download manager and load initial data
      downloadManagerCleanup = initDownloadManager();
      await Promise.all([
        loadMods(serverPath),
        loadServerConfig(serverPath)
      ]);
    };
    
    // Start initialization
    initAsync();
    
    // Return cleanup function
    return () => {
      if (downloadManagerCleanup && typeof downloadManagerCleanup === 'function') {
        downloadManagerCleanup();
      }
    };
  });
  
  // Clean up on component destroy
  onDestroy(() => {
    if (downloadManagerCleanup && typeof downloadManagerCleanup === 'function') {
      downloadManagerCleanup();
    }
  });
  
  // Handle installing mod with dependencies
  async function handleInstallWithDependencies() {
    try {
      const result = await installWithDependencies(serverPath);
      
      if (!result) {
        // If installation failed, ensure we clean up any installing state
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
      
      // Clean up all installing state
      installingModIds.set(new Set());
    }
  }
  
  // Handle compatibility warning events
  async function handleCompatibilityWarning(event) {
    // Extract and ensure the modToUpdate has a source for download URL resolution
    const { issues: rawIssues, modToUpdate: rawMod } = event.detail;
    const modToUpdate = { ...rawMod, source: rawMod.source || 'modrinth' };
    
    try {
      
      // Enrich dependency names for missing issues by fetching project titles
      const issues = await Promise.all(rawIssues.map(async issue => {
        const dep = issue.dependency;
        // If name is generic, try to fetch from Modrinth
        if (dep && (!dep.name || dep.name === 'Required Dependency')) {
          try {
            const projectInfo = await safeInvoke('get-project-info', {
              projectId: dep.projectId,
              source: modToUpdate.source
            });
            if (projectInfo?.title) dep.name = projectInfo.title;
          } catch (err) {
          }
        }
        return issue;
      }));
      
      // Format dependencies for the dependency modal based on issue type
      const dependencies = issues.map(issue => {
        let dependencyType = 'required';
        // Ensure we have a clean name without any generic placeholder
        let name = issue.dependency?.name || '';
        
        // Remove any existing parenthetical notes that might be in the name
        if (name.includes('(')) {
          name = name.split('(')[0].trim();
        }
        
        // If we still have a generic name, try to get a better one
        if (!name || name === 'Required Dependency' || name === 'Mod' || name === 'Unknown' || name === 'Dependency') {
          // Try to get the projectId info
          const projectId = issue.dependency?.projectId;
          if (projectId) {
            // If this is a version mismatch issue, we should actually have a proper name already
            if (issue.type === 'version_mismatch') {
              name = 'Installed Mod';
            } else {
              name = 'Dependency';
            }
          } else {
            name = 'Required Dependency';
          }
        }
        
        // Keep track of the version requirement for proper installation
        const versionRequirement = issue.dependency?.versionRequirement;
        const currentVersionId = issue.dependency?.currentVersionId;
        
        // Add version info separately
        let versionInfo = '';
        if (issue.type === 'missing') {
          dependencyType = 'required';
          if (issue.requiredVersion) {
            versionInfo = `Version ${issue.requiredVersion} required`;
          }
        } else if (issue.type === 'version_mismatch') {
          dependencyType = 'compatibility';
          if (issue.installedVersion && issue.requiredVersion) {
            versionInfo = `${issue.installedVersion} → ${issue.requiredVersion}`;
          }
        } else if (issue.type === 'update_available') {
          dependencyType = 'optional';
          if (issue.installedVersion && issue.updateVersion) {
            versionInfo = `${issue.installedVersion} → ${issue.updateVersion}`;
          }
        }
        
        
        return {
          projectId: issue.dependency?.projectId,
          name: name,
          versionInfo: versionInfo,
          dependencyType: dependencyType,
          // Pass version requirements for smart installation
          versionRequirement: versionRequirement,
          currentVersionId: currentVersionId,
          // Add requiredVersion from the issue
          requiredVersion: issue.requiredVersion
        };
      });
      
      // Show the dependency modal with compatibility warnings
      showDependencyModal(modToUpdate, dependencies);
    } catch (error) {
      errorMessage.set(`Error checking dependencies: ${error.message || 'Unknown error'}`);
    }
  }
  
  // Handle mod installation
  async function handleInstallMod(event) {
    const { mod, versionId, isVersionChange } = event.detail;
    
    try {
      // Mark this mod as being installed to prevent duplicate installation attempts
      installingModIds.update(ids => {
        ids.add(mod.id);
        return ids;
      });
      
      // If this is a version change for an already installed mod
      if (isVersionChange) {
        // Create a proper mod object for installation
        const modToUpdate = {
          id: mod.id,
          name: mod.name || mod.title, 
          title: mod.name || mod.title,
          selectedVersionId: versionId,
          source: mod.source || 'modrinth'
        };
        
        // Try to get version info for compatibility checking
        try {
          if (versionId) {
            // Get specific version info if we have a versionId
            
            try {
              const versionInfo = await safeInvoke('get-version-info', {
                modId: mod.id,
                versionId: versionId,
                source: mod.source || 'modrinth',
                loader: get(loaderType),
                gameVersion: get(minecraftVersion)
              });
              
              if (versionInfo && versionInfo.dependencies && versionInfo.dependencies.length > 0) {
                // Check for compatibility issues, passing the mod ID to avoid self-dependencies
                const compatibilityIssues = await checkDependencyCompatibility(versionInfo.dependencies, mod.id);
                
                // If there are compatibility issues, show them
                if (compatibilityIssues.length > 0) {
                  dispatch('compatibility-warning', {
                    issues: compatibilityIssues,
                    modToUpdate: modToUpdate
                  });
                  
                  // Clear installing state since we're waiting for user decision
                  installingModIds.update(ids => {
                    ids.delete(mod.id);
                    return ids;
                  });
                  
                  return;
                }
              }
            } catch (versionError) {
              // Set a more user-friendly error message
              if (versionError.message && versionError.message.includes('404')) {
                errorMessage.set(`Couldn't find version information for this mod. It may have been removed from Modrinth.`);
              } else {
                errorMessage.set(`Failed to check version compatibility: ${versionError.message || 'Unknown error'}`);
              }
              
              // Clear installing state on version info error
              installingModIds.update(ids => {
                ids.delete(mod.id);
                return ids;
              });
              return; // Exit early since we can't proceed without proper version info
            }
          }
        } catch (compatError) {
          // Continue with the regular dependency check
        }
        
        // Install (will replace existing version)
        await installMod(modToUpdate, serverPath);
        
        // Clear installing state
        installingModIds.update(ids => {
          ids.delete(mod.id);
          return ids;
        });
        
        return;
      }
      
      // Regular installation with dependency check
      // Always check for dependencies even for reinstalling mods
      try {
        const dependencies = await checkModDependencies(mod);
        
        // Get the version info to also check for compatibility issues
        let compatibilityIssues = [];
        try {
          if (versionId) {
            // Get specific version info if we have a versionId
            const versionInfo = await safeInvoke('get-version-info', {
              modId: mod.id,
              versionId: versionId,
              source: mod.source || 'modrinth',
              loader: get(loaderType),
              gameVersion: get(minecraftVersion)
            });
            
            
            if (versionInfo && versionInfo.dependencies && versionInfo.dependencies.length > 0) {
              // Check for compatibility issues, passing the mod ID to avoid self-dependencies
              compatibilityIssues = await checkDependencyCompatibility(versionInfo.dependencies, mod.id);
            }
          }
        } catch (compatError) {
          // Continue with the regular dependency check
        }
        
        // If has dependencies, show modal
        if (dependencies && dependencies.length > 0) {
          // Add any compatibility issues to the dependencies message
          if (compatibilityIssues.length > 0) {
            // This will add compatibility issues to the dependency dialog
            dependencies.push(...compatibilityIssues.map(issue => ({
              projectId: issue.dependency.projectId,
              name: `${issue.dependency.name} (${issue.message})`,
              dependencyType: 'compatibility'
            })));
          }
          
          showDependencyModal(mod, dependencies);
        } else if (compatibilityIssues.length > 0) {
          // Use existing compatibility warning handler to format and show dependency modal
          await handleCompatibilityWarning({ detail: {
            issues: compatibilityIssues,
            modToUpdate: {
              id: mod.id,
              name: mod.name || mod.title,
              selectedVersionId: versionId
            }
          }});
          // Clear installing state since we're waiting for user decision
          installingModIds.update(ids => {
            ids.delete(mod.id);
            return ids;
          });
          return;
        } else {
          // No dependencies or compatibility issues, install directly
          await installMod(mod, serverPath);
          
          // Clear installing state after installation
          installingModIds.update(ids => {
            ids.delete(mod.id);
            return ids;
          });
        }
      } catch (depError) {
        
        // Don't just try to install the mod if dependency checking fails
        // Instead, show a meaningful error to the user
        errorMessage.set(`Warning: Failed to check for dependencies. This mod may not work correctly if it requires dependencies. ${depError.message || ''}`);
        
        // Ask the user if they want to continue with installation
        if (confirm(`Warning: Failed to check if the mod "${mod.name || mod.title}" requires dependencies. Continue with installation anyway?`)) {
          // If user confirms, proceed with installation
          await installMod(mod, serverPath);
        } else {
        }
        
        // Clear installing state after installation
        installingModIds.update(ids => {
          ids.delete(mod.id);
          return ids;
        });
      }
    } catch (error) {
      errorMessage.set(`Failed to install mod: ${error.message || 'Unknown error'}`);
      
      // Clear installing state on error
      installingModIds.update(ids => {
        ids.delete(mod.id);
        return ids;
      });
    }
  }
    // Handle mod update from InstalledModList
  async function handleUpdateMod(event) {
    const { modName, projectId, versionId } = event.detail;
    
    try {
      // Find the mod name without file extension
      const baseName = modName.replace(/\.jar$/i, '');
      
      // Create a proper mod object for installation
      const mod = {
        id: projectId,
        name: baseName, // Use name without extension
        title: baseName, // Make sure title is set as well
        selectedVersionId: versionId,
        source: 'modrinth'
      };
        // Remove this mod from the updates list immediately to prevent duplicate clicks
      modsWithUpdates.update(updates => {
        updates.delete(modName);
        return updates;
      });
      
      // Install the new version (it will replace the old one automatically)
      const success = await installMod(mod, serverPath);
      
      if (success) {
        // Force a full reload of installed mods to refresh version information
        await loadMods(serverPath);
        
        // Check for updates immediately to update UI state if we installed an older version
        await checkForUpdates(serverPath);
        
        // Don't automatically expand the dropdown - let the user choose to open it
        // This avoids the "loading versions" issue
        expandedInstalledMod.set(null);
      }
    } catch (error) {
      errorMessage.set(`Failed to update mod: ${error.message || 'Unknown error'}`);
    }  }
  
  // Handle filter change
  async function handleFilterChange(event) {
    const { filterType: newFilterType, 
            filterMinecraftVersion: newVersionFilter, 
            filterModLoader: newLoaderFilter } = event.detail;
    
    filterType = newFilterType;
    filterMinecraftVersion.set(newVersionFilter);
    filterModLoader.set(newLoaderFilter);
  }
  
  // Handle search
  async function handleSearch() {
    try {
      isSearching.set(true);
      
      // Reset to empty values first
      searchResults.set([]);
      totalResults.set(0);
      totalPages.set(1);
      
      // Perform search
      await searchMods();
      
    } catch (error) {
      errorMessage.set(`Search failed: ${error.message || 'Unknown error'}`);
    } finally {
      isSearching.set(false);
    }
  }
  
  // Watch for changes to the minecraftVersion store
  $: {
    if ($minecraftVersion) {
      // Make sure filterMinecraftVersion is set to the current version
      filterMinecraftVersion.set($minecraftVersion);
      // Add the current version to options if not already included
      if (!minecraftVersionOptions.includes($minecraftVersion)) {
        minecraftVersionOptions = [$minecraftVersion, ...minecraftVersionOptions.filter(v => v !== $minecraftVersion)];
      }
    }
  }
  
  // Watch for tab changes and load search results when switching to search tab
  $: if (activeTab === 'search' && get(searchResults).length === 0) {
    handleSearch();
  }
  

    // Handle tab switching
  function switchTab(tabName) {
    if (activeTab === tabName) return;
    
    // Set the active tab
    activeTab = tabName;
    
    // Clear any expanded dropdowns
    expandedInstalledMod.set(null);
    
    // If switching to installed tab, refresh mod list
    if (tabName === 'installed') {
      loadMods(serverPath);
      checkForUpdates(serverPath);
    }
    // If switching to search tab, refresh search results and check for updates
    else if (tabName === 'search') {
      // Clear any stale update counts when switching away from installed tab
      modsWithUpdates.set(new Map());
      
      // Always check for updates when switching to search tab to ensure update buttons are shown
      checkForUpdates(serverPath).then(() => {
        // Only search if no results yet or explicitly requested
        if (get(searchResults).length === 0) {
          handleSearch();
        }
      });
    }
  }
  
  function handleTabKeydown(event, tabName) {
    if (event.key === 'Enter' || event.key === ' ') {
      event.preventDefault();
      switchTab(tabName);
    }
  }
  
  async function handleRefresh() {
    // Clear any cached data
    try {
      // Show loading indicator
      isLoading.set(true);
      errorMessage.set('');
      
      // Reload mods list
      await loadMods(serverPath);
      
      // Force update of any version selection dropdowns
      expandedInstalledMod.set(null);
      
      isLoading.set(false);
      successMessage.set('Mod information refreshed successfully!');
      
      // Clear success message after a delay
      setTimeout(() => {
        successMessage.set('');
      }, 2000);
    } catch (error) {
      isLoading.set(false);
      errorMessage.set(`Failed to refresh mods: ${error.message}`);
    }
  }
  
  /**
   * Handle install dependencies request from InstalledModList
   */
  async function handleInstallDependenciesFromModList(event) {
    // Directly install dependencies without opening a secondary modal
    const { mod: rawMod, dependencies: rawDependencies } = event.detail;
    const mod = { ...rawMod, source: rawMod.source || 'modrinth' };
    
    try {
      // Set up stores for installWithDependencies
      modToInstall.set(mod);
      currentDependencies.set(rawDependencies);
      // Perform the installation immediately
      await installWithDependencies(serverPath);
    } catch (error) {
      errorMessage.set(`Error installing dependencies: ${error.message || 'Unknown error'}`);
    }
  }
</script>

<div class="mod-manager">
  <StatusManager />
  <DownloadProgress />
  <ModDependencyModal on:install={handleInstallWithDependencies} />
  
  <div class="mod-manager-tabs" role="tablist">
    <button 
      type="button"
      class="tab" 
      class:active={activeTab === 'installed'}
      on:click={() => switchTab('installed')}
      on:keydown={(e) => handleTabKeydown(e, 'installed')}
      aria-selected={activeTab === 'installed'}
      aria-controls="installed-tab-panel"
      id="installed-tab"
      role="tab"
      tabindex={activeTab === 'installed' ? 0 : -1}
    >
      Installed Mods
    </button>
    <button 
      type="button"
      class="tab" 
      class:active={activeTab === 'search'}
      on:click={() => switchTab('search')}
      on:keydown={(e) => handleTabKeydown(e, 'search')}
      aria-selected={activeTab === 'search'}
      aria-controls="search-tab-panel"
      id="search-tab"
      role="tab"
      tabindex={activeTab === 'search' ? 0 : -1}
    >
      Find Mods
    </button>
  </div>
  
  <div class="mod-manager-content">
    <!-- Installed Mods Section -->
    <div 
      class="installed-mods-section" 
      style="display: {activeTab === 'installed' ? 'block' : 'none'}"
      id="installed-tab-panel"
      role="tabpanel"
      aria-labelledby="installed-tab"
      tabindex="0"
    >
      <h2>Installed Mods</h2>
      
      <InstalledModList 
        serverPath={serverPath}
        on:modRemoved={() => loadMods(serverPath)}
        on:updateMod={handleUpdateMod}
        on:refresh={handleRefresh}
        on:compatibility-warning={handleCompatibilityWarning}
        on:install-dependencies={handleInstallDependenciesFromModList}
      />
    </div>
    
    <!-- Search Mods Section -->
    <div 
      class="search-mods-section" 
      style="display: {activeTab === 'search' ? 'block' : 'none'}"
      id="search-tab-panel"
      role="tabpanel"
      aria-labelledby="search-tab"
      tabindex="0"
    >
      <h2>Find Mods</h2>
      
      <ModSearch
        on:search={handleSearch}
        on:install={handleInstallMod}
        on:filterChange={handleFilterChange}
        serverPath={serverPath}
        {minecraftVersionOptions}
        bind:filterType
      />
      
      <div class="search-results">
        <!-- Results will be rendered by ModSearch component -->
      </div>
    </div>
  </div>
</div>

<style>
  .mod-manager {
    display: flex;
    flex-direction: column;
    height: 100%;
    overflow: hidden;
  }
  
  .mod-manager-tabs {
    display: flex;
    border-bottom: 1px solid var(--border-color);
    margin-bottom: 1rem;
  }
  
  .tab {
    padding: 0.75rem 1.5rem;
    cursor: pointer;
    border-bottom: 2px solid transparent;
    transition: all 0.2s ease;
    background: none;
    border: none;
    font-size: inherit;
    font-family: inherit;
    color: inherit;
    text-align: left;
  }
  
  .tab.active {
    border-bottom-color: var(--primary-color);
    color: var(--primary-color);
    font-weight: 500;
  }
  
  .tab:hover:not(.active) {
    border-bottom-color: var(--border-color);
    background-color: var(--bg-hover);
  }
  
  .mod-manager-content {
    flex: 1;
    overflow-y: auto;
    padding: 0 1rem;
  }
  
  h2 {
    margin-top: 0;
    margin-bottom: 1rem;
    font-size: 1.5rem;
    font-weight: 500;
  }
  
  .installed-mods-section,
  .search-mods-section {
    height: 100%;
  }
</style> 