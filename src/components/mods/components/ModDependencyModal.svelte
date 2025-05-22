<!-- @ts-ignore -->
<script>
  import { createEventDispatcher } from 'svelte';
  import { dependencyModalOpen, modToInstall, currentDependencies, installingModIds } from '../../../stores/modStore.js';
  
  // Event dispatcher
  const dispatch = createEventDispatcher();
  
  // Reference for focus management
  let confirmButton;
  let previousFocus;
  
  // Initialize dependency arrays
  let requiredDeps = [];
  let compatibilityDeps = [];
  let optionalDeps = [];
  
  // Group dependencies by type and prevent duplicates
  $: {
    // Create a Set to track project IDs we've already processed
    const processedIds = new Set();
    const processedNames = new Map(); // Track names for better deduplication
    
    // If we have a main mod, add its ID to the processed IDs to avoid showing as a dependency
    if ($modToInstall && $modToInstall.id) {
      processedIds.add($modToInstall.id.toLowerCase()); // Convert to lowercase for case-insensitive comparison
    }
    
    // First process required (missing) dependencies
    requiredDeps = $currentDependencies
      .filter(dep => dep.dependencyType === 'required')
      .filter(dep => {
        if (!dep.projectId) return true; // Keep deps without projectId (shouldn't happen)
        
        // Case-insensitive check
        const lowerId = dep.projectId.toLowerCase();
        
        // Check for exact name match to avoid duplicates with different IDs but same name
        // This handles "Fabric API" appearing multiple times with different IDs
        const cleanedName = cleanModName(dep.name);
        if (cleanedName && processedNames.has(cleanedName)) {
          // It's a duplicate by name
          console.log(`Filtering out duplicate dependency by name: ${cleanedName}`);
          return false;
        }
        
        if (!processedIds.has(lowerId)) {
          processedIds.add(lowerId);
          
          // Remember the name for future checks
          if (cleanedName) {
            processedNames.set(cleanedName, lowerId);
          }
          
          return true;
        }
        return false;
      });
    
    // Then process compatibility issues, excluding anything already in required
    compatibilityDeps = $currentDependencies
      .filter(dep => 
        dep.dependencyType === 'compatibility' && 
        (dep.name !== 'Required Dependency' || (dep.installedVersion && dep.targetVersion))
      )
      .filter(dep => {
        if (!dep.projectId) return true; // Keep deps without projectId (shouldn't happen)
        
        // Case-insensitive check
        const lowerId = dep.projectId.toLowerCase();
        
        // Check for exact name match
        const cleanedName = cleanModName(dep.name);
        if (cleanedName && processedNames.has(cleanedName)) {
          return false;
        }
        
        if (!processedIds.has(lowerId)) {
          processedIds.add(lowerId);
          
          // Remember the name
          if (cleanedName) {
            processedNames.set(cleanedName, lowerId);
          }
          
          return true;
        }
        return false;
      });
    
    // Finally process optional updates, excluding anything already processed
    optionalDeps = $currentDependencies
      .filter(dep => dep.dependencyType === 'optional')
      .filter(dep => {
        if (!dep.projectId) return true; // Keep deps without projectId (shouldn't happen)
        
        // Case-insensitive check
        const lowerId = dep.projectId.toLowerCase();
        
        // Check for exact name match
        const cleanedName = cleanModName(dep.name);
        if (cleanedName && processedNames.has(cleanedName)) {
          return false;
        }
        
        if (!processedIds.has(lowerId)) {
          processedIds.add(lowerId);
          
          // Remember the name
          if (cleanedName) {
            processedNames.set(cleanedName, lowerId);
          }
          
          return true;
        }
        return false;
      });
  }
  
  // Clean mod name (remove ID parts for display)
  function cleanModName(name) {
    if (!name) return 'Unknown Dependency';
    
    // If the name contains a pattern like "Mod (ID: xyz...)", extract just the name
    if (name.includes('(ID:')) {
      // Try to get just the mod name if it exists in front of the ID
      const modNamePart = name.split('(ID:')[0].trim();
      if (modNamePart && modNamePart !== 'Mod' && modNamePart !== 'Dependency') {
        return modNamePart;
      }
      
      // Otherwise, just show a generic name
      return 'Required Dependency';
    }
    
    // If the name contains a pattern with version info in parentheses, keep just the name part
    if (name.includes('(Version') || name.includes('(Missing') || name.includes('(Update') || name.includes('(Required')) {
      return name.split('(')[0].trim();
    }
    
    return name;
  }
  
  // Get version info for display
  function getVersionInfo(dependency) {
    if (!dependency) return '';
    
    // If dependency has explicit versionInfo field, use that first (from our enhanced dependency checks)
    if (dependency.versionInfo) {
      return dependency.versionInfo;
    }
    
    // For missing dependencies, show the version to be installed
    if (dependency.dependencyType === 'required' && dependency.requiredVersion) {
      if (dependency.latestVersion && dependency.requiredVersion !== dependency.latestVersion) {
        return `v${dependency.requiredVersion} (latest: v${dependency.latestVersion})`;
      } else {
        return `v${dependency.requiredVersion}`;
      }
    }
    
    // For compatibility issues, show current → target version
    if (dependency.dependencyType === 'compatibility') {
      if (dependency.installedVersion && (dependency.targetVersion || dependency.versionRequirement)) {
        return `v${dependency.installedVersion} → ${dependency.targetVersion || dependency.versionRequirement}`;
      } else if (dependency.versionRequirement) {
        return `Needs version ${dependency.versionRequirement}`;
      }
    }
    
    // For optional updates
    if (dependency.dependencyType === 'optional' && dependency.installedVersion && dependency.updateVersion) {
      return `v${dependency.installedVersion} → v${dependency.updateVersion}`;
    }
    
    // Extract version info from name if present
    if (dependency.name && dependency.name.includes('(Version')) {
      const match = dependency.name.match(/\(Version (.*?) → (.*?)\)/);
      if (match && match.length >= 3) {
        return `v${match[1]} → v${match[2]}`;
      }
    }
    
    // Use version requirement if available
    if (dependency.versionRequirement) {
      return `Requirement: ${dependency.versionRequirement}`;
    }
    
    return '';
  }
  
  // Handlers
  function handleKeydown(event) {
    if (!$dependencyModalOpen) return;
    
    if (event.key === 'Escape') {
      cancel();
    } else if (event.key === 'Enter' && document.activeElement !== confirmButton) {
      proceedWithInstall();
    }
  }
  
  function closeModal(event) {
    // Only close if clicking directly on the backdrop
    if (event.target === event.currentTarget) {
      cancel();
    }
  }
  
  function proceedWithInstall() {
    dispatch('install');
    $dependencyModalOpen = false;
  }
  
  function cancel() {
    const mod = $modToInstall;
    
    // Clear the installing state for the mod when canceling
    if (mod && mod.id) {
      // Update the installingModIds store to remove this mod
      installingModIds.update(ids => {
        ids.delete(mod.id);
        return ids;
      });
      
      // Also remove any dependencies from installing state
      if ($currentDependencies && $currentDependencies.length > 0) {
        installingModIds.update(ids => {
          for (const dep of $currentDependencies) {
            if (dep.projectId) {
              ids.delete(dep.projectId);
            }
          }
          return ids;
        });
      }
      
      // Log the cancel operation
      console.log(`Canceled installation for mod: ${mod.name} (${mod.id})`);
    }
    
    // Clear the dependency modal state
    $modToInstall = null;
    $currentDependencies = [];
    $dependencyModalOpen = false;
  }
  
  // Watch for visibility changes to manage focus
  $: if ($dependencyModalOpen) {
    // Store current focus
    previousFocus = document.activeElement;
    
    // Focus the confirm button once the component updates
    setTimeout(() => {
      if (confirmButton) {
        confirmButton.focus();
      }
    }, 0);
  } else if (previousFocus) {
    // Restore previous focus when modal closes
    previousFocus.focus();
  }
</script>

<svelte:window on:keydown={handleKeydown} />

{#if $dependencyModalOpen}
  <div 
    class="modal-overlay" 
    on:click={closeModal}
    role="dialog"
    aria-modal="true"
    aria-labelledby="dependency-modal-title"
    aria-describedby="dependency-modal-description"
  >
    <div 
      class="modal-content" 
      on:click|stopPropagation
      role="document"
    >
      <h3 id="dependency-modal-title">Required Dependencies</h3>
      
      <p id="dependency-modal-description">
        The mod <strong>{$modToInstall?.name || 'selected'}</strong> requires the following dependencies:
      </p>
      
      <div class="dependencies-container">
        {#if requiredDeps.length > 0}
          <h4>Missing Dependencies</h4>
          <ul class="dependencies-list required" aria-label="Required dependencies list">
            {#each requiredDeps as dependency}
              {@const displayName = cleanModName(dependency.name)}
              <li class="dependency-item">
                <span class="dependency-name">
                  {displayName}
                  {#if getVersionInfo(dependency)}
                    <span class="version-note">{getVersionInfo(dependency)}</span>
                  {/if}
                </span>
                <span class="dependency-type required">required</span>
              </li>
            {/each}
          </ul>
        {/if}
        
        {#if compatibilityDeps.length > 0}
          <h4>Version Compatibility Issues</h4>
          <ul class="dependencies-list compatibility" aria-label="Compatibility issues list">
            {#each compatibilityDeps as dependency}
              {@const displayName = dependency.name}
              <li class="dependency-item">
                <span class="dependency-name">
                  {displayName || "Installed Mod"}
                  {#if getVersionInfo(dependency)}
                    <span class="version-note">{getVersionInfo(dependency)}</span>
                  {/if}
                </span>
                <span class="dependency-type compatibility">compatibility</span>
              </li>
            {/each}
          </ul>
          <p class="info-text">These dependencies are installed but at incorrect versions. Proceeding will update them to compatible versions.</p>
        {/if}
        
        {#if optionalDeps.length > 0}
          <h4>Optional Updates</h4>
          <ul class="dependencies-list optional" aria-label="Optional updates list">
            {#each optionalDeps as dependency}
              {@const displayName = cleanModName(dependency.name)}
              <li class="dependency-item">
                <span class="dependency-name">
                  {displayName}
                  {#if getVersionInfo(dependency)}
                    <span class="version-note">{getVersionInfo(dependency)}</span>
                  {/if}
                </span>
                <span class="dependency-type optional">optional</span>
              </li>
            {/each}
          </ul>
          <p class="info-text">These updates are recommended but not strictly required.</p>
        {/if}
      </div>
      
      <p>Would you like to install these dependencies along with the mod?</p>
      
      <div class="modal-actions">
        <button 
          class="cancel-button" 
          on:click={cancel}
          type="button"
        >
          Cancel
        </button>
        <button 
          class="install-button" 
          on:click={proceedWithInstall}
          type="button"
          bind:this={confirmButton}
        >
          {#if requiredDeps.length > 0}
            Install All Required Dependencies
          {:else if compatibilityDeps.length > 0}
            Update Compatibility Issues
          {:else}
            Install All
          {/if}
        </button>
      </div>
    </div>
  </div>
{/if}

<style>
  .modal-overlay {
    position: fixed;
    top: 0;
    left: 0;
    right: 0;
    bottom: 0;
    background: rgba(0, 0, 0, 0.7);
    display: flex;
    justify-content: center;
    align-items: center;
    z-index: 1000;
    backdrop-filter: blur(3px);
  }
  
  .modal-content {
    background: #272727;
    border-radius: 8px;
    width: 90%;
    max-width: 500px;
    max-height: 90vh;
    overflow-y: auto;
    padding: 20px;
    box-shadow: 0 4px 20px rgba(0, 0, 0, 0.5);
    border: 1px solid rgba(255, 255, 255, 0.1);
  }
  
  h3 {
    margin-top: 0;
    color: #ff9800;
    border-bottom: 1px solid rgba(255, 255, 255, 0.1);
    padding-bottom: 10px;
  }
  
  h4 {
    margin: 15px 0 5px 0;
    font-size: 0.95rem;
    color: rgba(255, 255, 255, 0.9);
  }
  
  .dependencies-container {
    max-height: 300px;
    overflow-y: auto;
    background: rgba(0, 0, 0, 0.2);
    border-radius: 6px;
    padding: 10px;
    margin: 15px 0;
  }
  
  .dependencies-list {
    list-style: none;
    padding: 0;
    margin: 5px 0;
  }
  
  .dependencies-list.required {
    border-left: 3px solid #f44336;
    padding-left: 10px;
  }
  
  .dependencies-list.compatibility {
    border-left: 3px solid #ff9800;
    padding-left: 10px;
  }
  
  .dependencies-list.optional {
    border-left: 3px solid #4caf50;
    padding-left: 10px;
    opacity: 0.9;
  }
  
  .dependency-item {
    padding: 8px 0;
    border-bottom: 1px solid rgba(255, 255, 255, 0.05);
    display: flex;
    justify-content: space-between;
    align-items: center;
  }
  
  .dependency-item:last-child {
    border-bottom: none;
  }
  
  .dependency-name {
    font-weight: 500;
    word-break: break-word;
    flex: 1;
    display: flex;
    flex-direction: column;
  }
  
  .dependency-type {
    font-size: 12px;
    padding: 2px 6px;
    border-radius: 10px;
    margin-left: 8px;
    text-transform: uppercase;
    font-weight: 600;
  }
  
  .dependency-type.required {
    background: rgba(244, 67, 54, 0.2);
    color: #ff6b6b;
  }
  
  .dependency-type.compatibility {
    background: rgba(255, 152, 0, 0.2);
    color: #ffae42;
  }
  
  .dependency-type.optional {
    background: rgba(76, 175, 80, 0.2);
    color: #66bb6a;
  }
  
  .info-text {
    font-size: 0.8rem;
    font-style: italic;
    color: rgba(255, 255, 255, 0.6);
    margin: 5px 0 10px 0;
  }
  
  .modal-actions {
    display: flex;
    justify-content: flex-end;
    gap: 10px;
    margin-top: 20px;
  }
  
  button {
    padding: 8px 16px;
    border-radius: 4px;
    border: none;
    font-weight: 500;
    cursor: pointer;
    transition: all 0.2s;
  }
  
  .cancel-button {
    background: rgba(255, 255, 255, 0.1);
    color: rgba(255, 255, 255, 0.8);
  }
  
  .cancel-button:hover {
    background: rgba(255, 255, 255, 0.2);
  }
  
  .install-button {
    background: #4caf50;
    color: white;
  }
  
  .install-button:hover {
    background: #3b8a3e;
  }
  
  .version-note {
    display: block;
    font-size: 0.8rem;
    font-weight: normal;
    color: rgba(255, 255, 255, 0.6);
    margin-top: 2px;
  }
</style> 