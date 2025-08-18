<script>
  import { onMount, onDestroy } from 'svelte';
  
  import { SvelteSet, SvelteMap } from 'svelte/reactivity';
  import { get } from 'svelte/store';
  import { createEventDispatcher } from 'svelte';
  import { safeInvoke } from '../../utils/ipcUtils.js';
  // Import stores
  import { 
    installingModIds,
    searchResults,
    successMessage, 
    errorMessage,
    installedModInfo,
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
    modToInstall,
    // Content type stores
    activeContentType,
    shaderResults,
    resourcePackResults,
    CONTENT_TYPES,
    contentTypeConfigs,
    // Performance optimization stores
    contentTypeSwitching
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
  let downloadManagerCleanup;
  let activeTab = 'installed'; // 'installed' or 'search' or 'categories'
  
  // Content type configuration
  const contentTypes = [
    { id: CONTENT_TYPES.MODS, label: 'Mods', icon: '🧩' },
    { id: CONTENT_TYPES.SHADERS, label: 'Shaders', icon: '✨' },
    { id: CONTENT_TYPES.RESOURCE_PACKS, label: 'Resource Packs', icon: '🎨' }
  ];
  
  // Initialize filter stores (only for mods to avoid version filter ping-pong on shaders/resource packs)
  $: if (
    $minecraftVersion &&
    $activeContentType === CONTENT_TYPES.MODS &&
    $filterMinecraftVersion === ''
  ) {
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

      // Post-load sanity: if installed mod info lacks versions initially, trigger one light refresh
      try {
        const info = get(installedModInfo);
        const missingVersions = !info || info.length === 0 || info.every(i => !i?.versionNumber);
        if (missingVersions) {
          // Small delay to allow backend to warm up, then refresh once
          setTimeout(() => {
            loadMods(serverPath);
          }, 250);
        }
      } catch (_) {
        // ignore
      }
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
      const result = await installWithDependencies(serverPath, installMod, $activeContentType);
      
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
      installingModIds.set(new SvelteSet());
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
    const { mod, versionId, isVersionChange, isDependency, onSuccess, onError, contentType } = event.detail;
    

    
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
        // Use contentType from event if provided (for dependencies), otherwise use active content type
        const targetContentType = contentType || $activeContentType;
        

        
        const installSuccess = await installMod(modToUpdate, serverPath, { contentType: targetContentType });
        
        // Clear installing state
        installingModIds.update(ids => {
          ids.delete(mod.id);
          return ids;
        });
        
        // Call success callback if provided and installation was successful
        if (installSuccess && onSuccess) {
          try {
            await onSuccess();
          } catch (callbackError) {
            // Success callback failed
          }
        }
        
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
          // Use contentType from event if provided (for dependencies), otherwise use active content type
          const targetContentType = contentType || $activeContentType;
          

          
          const installSuccess = await installMod(mod, serverPath, { contentType: targetContentType });
          
          // Clear installing state after installation
          installingModIds.update(ids => {
            ids.delete(mod.id);
            return ids;
          });
          
          // Call success callback if provided and installation was successful
          if (installSuccess && onSuccess) {
            try {
              await onSuccess();
            } catch (callbackError) {
              // Success callback failed
            }
          } else if (installSuccess && isDependency) {
            // Show specific success message for dependency installations
            successMessage.set(`Dependency "${mod.name || mod.title}" installed successfully!`);
            setTimeout(() => successMessage.set(''), 3000);
          }
        }
      } catch (depError) {
        
        // Don't just try to install the mod if dependency checking fails
        // Instead, show a meaningful error to the user
        errorMessage.set(`Warning: Failed to check for dependencies. This mod may not work correctly if it requires dependencies. ${depError.message || ''}`);
        
        // Ask the user if they want to continue with installation
        if (confirm(`Warning: Failed to check if the mod "${mod.name || mod.title}" requires dependencies. Continue with installation anyway?`)) {
          // If user confirms, proceed with installation
          // Use contentType from event if provided (for dependencies), otherwise use active content type
          const targetContentType = contentType || $activeContentType;
          

          
          const installSuccess = await installMod(mod, serverPath, { contentType: targetContentType });
          
          // Call success callback if provided and installation was successful
          if (installSuccess && onSuccess) {
            try {
              await onSuccess();
            } catch (callbackError) {
              // Success callback failed
            }
          }
        } else {
          // User cancelled, call error callback if provided
          if (onError) {
            try {
              onError(new Error('Installation cancelled by user'));
            } catch (callbackError) {
              // Error callback failed
            }
          }
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
      
      // Call error callback if provided
      if (onError) {
        try {
          onError(error);
        } catch (callbackError) {
          // Error callback failed
        }
      }
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
      const success = await installMod(mod, serverPath, { contentType: $activeContentType });
      
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
    const { filterMinecraftVersion: newVersionFilter, 
            filterModLoader: newLoaderFilter } = event.detail;
    
    filterMinecraftVersion.set(newVersionFilter);
    filterModLoader.set(newLoaderFilter);
  }
  
  // Handle search
  async function handleSearch() {
    try {
      isSearching.set(true);
      
      // Reset to empty values first based on content type
      const currentContentType = get(activeContentType);
      switch (currentContentType) {
        case CONTENT_TYPES.SHADERS:
          shaderResults.set([]);
          break;
        case CONTENT_TYPES.RESOURCE_PACKS:
          resourcePackResults.set([]);
          break;
        case CONTENT_TYPES.MODS:
        default:
          searchResults.set([]);
          break;
      }
      totalResults.set(0);
      totalPages.set(1);
      
      // Import searchContent function
      const { searchContent } = await import('../../utils/mods/modAPI.js');
      
      // Perform search for the active content type
      await searchContent(currentContentType);
      
    } catch (error) {
      errorMessage.set(`Search failed: ${error.message || 'Unknown error'}`);
    } finally {
      isSearching.set(false);
    }
  }
  
  // Watch for changes to the minecraftVersion store
  $: {
    if ($minecraftVersion) {
      // Only force filter version for mods to avoid conflicts with shaders/resource packs
      if ($activeContentType === CONTENT_TYPES.MODS) {
        filterMinecraftVersion.set($minecraftVersion);
      }
      // Add the current version to options if not already included
      if (!minecraftVersionOptions.includes($minecraftVersion)) {
        minecraftVersionOptions = [$minecraftVersion, ...minecraftVersionOptions.filter(v => v !== $minecraftVersion)];
      }
    }
  }
  
  // Watch for tab changes and load search results when switching to search tab
  $: if (activeTab === 'search') {
    const currentType = get(activeContentType);
    const hasResults = currentType === CONTENT_TYPES.SHADERS
      ? get(shaderResults).length > 0
      : currentType === CONTENT_TYPES.RESOURCE_PACKS
        ? get(resourcePackResults).length > 0
        : get(searchResults).length > 0;
    if (!hasResults) {
      handleSearch();
    }
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
      // Load content for the active content type, then check for updates
      (async () => {
        try {
          const { loadContent } = await import('../../utils/mods/modAPI.js');
          await loadContent(serverPath, get(activeContentType));
        } catch (_) {}
        checkForUpdates(serverPath);
      })();
    }
    // If switching to search tab, refresh search results and check for updates
    else if (tabName === 'search') {
      // Clear any stale update counts when switching away from installed tab
      modsWithUpdates.set(new SvelteMap());

      // Ensure installed IDs/info for the current content type are loaded
      (async () => {
        try {
          const { loadContent } = await import('../../utils/mods/modAPI.js');
          await loadContent(serverPath, get(activeContentType));
        } catch (_) {
          // ignore
        }
        // Always check for updates when switching to search tab to ensure update buttons are shown
        checkForUpdates(serverPath).then(() => {
          // Only search if no results yet for the active content type
          const currentType = get(activeContentType);
          const hasResults = currentType === CONTENT_TYPES.SHADERS
            ? get(shaderResults).length > 0
            : currentType === CONTENT_TYPES.RESOURCE_PACKS
              ? get(resourcePackResults).length > 0
              : get(searchResults).length > 0;
          if (!hasResults) {
            handleSearch();
          }
        });
      })();
    }
  }
  
  // Handle content type switching with performance optimizations
  async function switchContentType(contentTypeId) {
    if ($activeContentType === contentTypeId) return;
    
    // Set switching state for loading indicator
    contentTypeSwitching.set(true);
    
    try {
      // Set the active content type
      activeContentType.set(contentTypeId);
      
      // Clear any expanded dropdowns
      expandedInstalledMod.set(null);
      
      // If on search tab, trigger search for new content type
      if (activeTab === 'search') {
        // Load installed IDs for this content type so search results can reflect installed status
        const { loadContent } = await import('../../utils/mods/modAPI.js');
        await loadContent(serverPath, contentTypeId);
        await handleSearch();
      }
      // If on installed tab, load content for new type
      else if (activeTab === 'installed') {
        // Import loadContent function
        const { loadContent } = await import('../../utils/mods/modAPI.js');
        await loadContent(serverPath, contentTypeId);
        // Ensure updates are checked for the newly selected content type
        // Use a follow-up check that can coalesce with any in-flight check
        try {
          const { checkForUpdates } = await import('../../utils/mods/modAPI.js');
          // Ask for a refresh to avoid stale cache when switching types
          checkForUpdates(serverPath, true);
        } catch (_) {}
      }
    } catch (error) {
      // Error switching content type
      // Optionally show user feedback
    } finally {
      // Clear switching state
      contentTypeSwitching.set(false);
    }
  }
  
  function handleTabKeydown(event, tabName) {
    if (event.key === 'Enter' || event.key === ' ') {
      event.preventDefault();
      switchTab(tabName);
    }
  }
  
  function handleContentTypeKeydown(event, contentTypeId) {
    if (event.key === 'Enter' || event.key === ' ') {
      event.preventDefault();
      switchContentType(contentTypeId);
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
      await installWithDependencies(serverPath, installMod, $activeContentType);
    } catch (error) {
      errorMessage.set(`Error installing dependencies: ${error.message || 'Unknown error'}`);
    }
  }
</script>

<div class="mod-manager">
  <StatusManager />
  <DownloadProgress />
  <ModDependencyModal on:install={handleInstallWithDependencies} />
  
  <!-- Content Type Tabs -->
  <div class="content-type-tabs" role="tablist">
    {#each contentTypes as contentType (contentType.id)}
      <button 
        type="button"
        class="content-type-tab" 
        class:active={$activeContentType === contentType.id}
        class:switching={$contentTypeSwitching && $activeContentType === contentType.id}
        disabled={$contentTypeSwitching}
        on:click={() => switchContentType(contentType.id)}
        on:keydown={(e) => handleContentTypeKeydown(e, contentType.id)}
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
      Installed {contentTypeConfigs[$activeContentType]?.label || 'Content'}
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
      Find {contentTypeConfigs[$activeContentType]?.label || 'Content'}
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
      <InstalledModList 
        serverPath={serverPath}
        on:modRemoved={() => loadMods(serverPath)}
        on:updateMod={handleUpdateMod}
        on:refresh={handleRefresh}
        on:compatibility-warning={handleCompatibilityWarning}
        on:install-dependencies={handleInstallDependenciesFromModList}
        on:install={handleInstallMod}
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
      <ModSearch
        on:search={handleSearch}
        on:install={handleInstallMod}
        on:filterChange={handleFilterChange}
        serverPath={serverPath}
        {minecraftVersionOptions}
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
    /* Use universal tab container styling with NO MARGIN */
    display: flex;
    background: var(--tab-container-bg);
    border-radius: var(--tab-container-border-radius);
    padding: var(--tab-container-padding);
    border: var(--tab-container-border);
    justify-content: center;
    gap: var(--tab-container-gap);
    margin: 0; /* NO margin */
  }
  
  .tab {
    /* EXACT SAME SIZE AS MAIN TABS - using universal system */
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
    
    /* Horizontal layout like client tabs */
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
  
  .mod-manager-content {
    flex: 1;
    padding: 0 1rem;
    width: 100%;
    max-width: 100%;
    box-sizing: border-box;
  }
  
  /* h2 headers removed - no longer needed since tabs indicate the content */
  

</style> 