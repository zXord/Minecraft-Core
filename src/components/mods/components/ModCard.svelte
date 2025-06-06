<!-- @ts-ignore -->
<script>
  import { createEventDispatcher } from 'svelte';
  import { get } from 'svelte/store';
  import { 
    installedModIds, 
    installingModIds, 
    expandedModId, 
    minecraftVersion,
    modsWithUpdates,
    installedModInfo
  } from '../../../stores/modStore.js';
  import { onMount } from 'svelte';
  import ModCardHeader from './ModCardHeader.svelte';
  import ModCardActions from './ModCardActions.svelte';
  import ModCardBody from './ModCardBody.svelte';
  
  // Props
  export let mod = {};
  export let expanded = false;
  export let versions = [];
  export let loading = false;
  export let error = null;
  export let filterMinecraftVersion = '';
  export let loadOnMount = false; // New flag to control whether to load versions on mount
  export let installedVersionId = ''; // ID of the currently installed version
  
  // Local state
  let selectedVersionId = mod.selectedVersionId || installedVersionId;
  let filteredVersions = [];
  let unfilteredVersions = []; // To store all stable versions
  let hasUpdate = false; // Add variable declaration for update status
  let updateInfo = null; // Add variable declaration for update information
  let updateVersionNumber = null; // Add variable declaration for update version number
  $: isInstalled = $installedModIds.has(mod.id);
  $: isInstalling = $installingModIds.has(mod.id);
  $: isChangingVersion = isInstalled && selectedVersionId && selectedVersionId !== installedVersionId;
  
  // Get installed mod information
  $: installedModData = $installedModInfo.find(info => info.projectId === mod.id);
  $: installedVersionNumber = installedModData?.versionNumber || '';
  
  // Get update information if available - check both ways: direct mod ID and installed mod's filename
  $: {
    // First, check if the mod ID is in the updates map (with special prefix)
    hasUpdate = isInstalled && ($modsWithUpdates.has(`project:${mod.id}`) || 
      // Then check if this mod's filename is in the updates map (used in installed tab)
      (installedModData && $modsWithUpdates.has(installedModData.fileName)));
      
    // Get update info from either source
    if (hasUpdate) {
      if ($modsWithUpdates.has(`project:${mod.id}`)) {
        updateInfo = $modsWithUpdates.get(`project:${mod.id}`);
      } else if (installedModData && $modsWithUpdates.has(installedModData.fileName)) {
        updateInfo = $modsWithUpdates.get(installedModData.fileName);
      } else {
        updateInfo = null;
      }
      
      updateVersionNumber = updateInfo?.versionNumber || null;
    } else {
      updateInfo = null;
      updateVersionNumber = null;
    }
  }
  
  // Event dispatcher
  const dispatch = createEventDispatcher();
  
  // Filter versions based on selected Minecraft version
  $: {
    if (versions.length > 0) {
      // First, get all stable versions (non-alpha, non-beta)
      unfilteredVersions = versions.filter(v => v.isStable !== false);
      
      if (filterMinecraftVersion) {
        // Show versions compatible with selected Minecraft version
        // Use more lenient matching that includes versions likely to work
        const exactMatches = versions.filter(v => 
          v.gameVersions.includes(filterMinecraftVersion) && v.isStable !== false
        );
        
        // If we have exact matches, use those
        if (exactMatches.length > 0) {
          filteredVersions = exactMatches;
        } else {
          // For 1.21.x, try to match versions that might work even if not tagged
          const mcVersionParts = filterMinecraftVersion.split('.');
          if (mcVersionParts.length >= 2 && mcVersionParts[0] === '1') {
            const majorMinorPrefix = `${mcVersionParts[0]}.${mcVersionParts[1]}`;
            
            // Find versions that match the major.minor version
            const likelyCompatible = versions.filter(v => {
              return v.isStable !== false && v.gameVersions.some(gameVer => 
                gameVer.startsWith(majorMinorPrefix)
              );
            });
            
            if (likelyCompatible.length > 0) {
              filteredVersions = likelyCompatible;
            } else {
              // No exact or likely matches, fall back to all stable versions
              filteredVersions = unfilteredVersions;
            }
          } else {
            // For non-standard versions, fall back to all stable versions
            filteredVersions = unfilteredVersions;
          }
        }
        
        // If still no versions, show all versions
        if (filteredVersions.length === 0) {
          filteredVersions = versions;
        }
      } else {
        // Show all stable versions when no specific version is selected
        filteredVersions = unfilteredVersions;
        
        // If no stable versions, show all versions
        if (filteredVersions.length === 0) {
          filteredVersions = versions;
        }
      }
    }
  }
  
  // When versions change, try to auto-select the best version
  $: if (filteredVersions.length > 0 && !selectedVersionId) {
    // If we're installed, try to select the installed version first
    if (isInstalled && installedVersionId) {
      const installedVersion = filteredVersions.find(v => v.id === installedVersionId);
      if (installedVersion) {
        selectedVersionId = installedVersionId;
      } else {
        selectedVersionId = selectBestVersion(filteredVersions);
      }
    } else {
      selectedVersionId = selectBestVersion(filteredVersions);
    }
    // Also update the mod object
    mod.selectedVersionId = selectedVersionId;
  }
  
  /**
   * Select the best version based on stability and release date
   * @param {Array} versions - Available versions
   * @returns {string} - Version ID
   */
  function selectBestVersion(versions) {
    // First filter for the selected Minecraft version if specified
    let compatibleVersions = versions;
    if (filterMinecraftVersion) {
      const mcVersionSpecificVersions = versions.filter(v => 
        v.gameVersions.includes(filterMinecraftVersion)
      );
      if (mcVersionSpecificVersions.length > 0) {
        compatibleVersions = mcVersionSpecificVersions;
      }
    }
    
    // Then try to find stable versions
    const stableVersions = compatibleVersions.filter(v => v.isStable !== false);
    const versionsToUse = stableVersions.length > 0 ? stableVersions : compatibleVersions;
    
    // Sort by date (newest first)
    const sortedVersions = [...versionsToUse].sort((a, b) => {
      const dateA = new Date(a.datePublished).getTime();
      const dateB = new Date(b.datePublished).getTime();
      return dateB - dateA;
    });
    
    // Return the ID of the first (newest) version
    return sortedVersions.length > 0 ? sortedVersions[0].id : null;
  }
  
  /**
   * Handle version selection
   * @param {Object} version - Selected version
   */
  function selectVersion(version) {
    selectedVersionId = version.id;
    mod.selectedVersionId = version.id;
    mod.selectedVersionName = version.name;
    mod.selectedVersionNumber = version.versionNumber;
    
    // Notify parent component
    dispatch('versionSelect', { mod, versionId: version.id });
    
    // If mod is already installed, don't trigger an update automatically
    // Let the user click the Change Version button explicitly
  }
  
  /**
   * Toggle version selector visibility
   */
  function toggleVersionSelector() {
    if (expanded) {
      expandedModId.set(null);
    } else {
      expandedModId.set(mod.id);
      
      // Load all versions when expanding the mod card
      // This ensures we get the full version list when the user wants to see it
      dispatch('loadVersions', { modId: mod.id, loadAll: true });
    }
  }
  
  /**
   * Toggle between showing version-filtered list and all versions
   * @param {boolean} showAll - Whether to show all versions
   */
  function toggleVersionFiltering(showAll = true) {
    if (showAll) {
      // Show all stable versions
      filteredVersions = unfilteredVersions.length > 0 ? unfilteredVersions : versions;
    } else if (filterMinecraftVersion) {
      // Apply filter again
      filteredVersions = versions.filter(v => 
        v.gameVersions.includes(filterMinecraftVersion) && v.isStable !== false
      );
    }
  }
  
  // When the component is mounted, conditionally load versions
  onMount(() => {
    // Only load the latest version on mount if configured to do so
    if (loadOnMount && (!versions || versions.length === 0)) {
      dispatch('loadVersions', { modId: mod.id, loadLatestOnly: true, loadAll: false });
    }
    
    // If we have an installed version, make sure that's preselected
    if (isInstalled && installedVersionId && !selectedVersionId) {
      selectedVersionId = installedVersionId;
      mod.selectedVersionId = installedVersionId;
    }
    
    // If this mod is installed, check for updates
    if (isInstalled && mod.id) {
      // For installed mods, we do need all versions to check updates properly
      dispatch('loadVersions', { modId: mod.id, loadAll: true });
    }
  });
  
  /**
   * Get the first character of a string for the icon placeholder
   * @param {string} str - String to get first character from
   * @returns {string} - First character or "M"
   */
  function getFirstChar(str) {
    if (!str) return 'M';
    return str.charAt(0).toUpperCase();
  }
  
  /**
   * Handle install button click
   * @param {boolean} isVersionChange - Whether this is changing version of an installed mod
   */
  function handleInstall(isVersionChange = false) {
    // Mark mod as installing
    installingModIds.update(ids => {
      ids.add(mod.id);
      return ids;
    });
    
    // Notify parent component to install the mod
    dispatch('install', {
      mod,
      versionId: selectedVersionId,
      isVersionChange
    });
  }

  /**
   * Click handler for the install/update button
   * @param {MouseEvent} e
   */
  function handleInstallClick(e) {
    e.stopPropagation();
    if (isInstalled) {
      if (expanded && isChangingVersion) {
        handleInstall(true);
      } else if (hasUpdate && !expanded) {
        if (updateInfo && updateInfo.id) {
          selectVersion(updateInfo);
          handleInstall(true);
        } else {
          toggleVersionSelector();
          dispatch('loadVersions', { modId: mod.id, loadAll: true });
        }
      } else {
        toggleVersionSelector();
      }
    } else {
      if (versions && versions.length > 0 && selectedVersionId) {
        handleInstall();
      } else {
        toggleVersionSelector();
        dispatch('loadVersions', { modId: mod.id, loadLatestOnly: true });
      }
    }
  }
  
  /**
   * Format a file size in bytes to a human-readable string
   * @param {number} bytes - File size in bytes
   * @returns {string} - Formatted size
   */
  function formatFileSize(bytes) {
    if (!bytes || isNaN(bytes)) {
      return '';
    }
    
    if (bytes < 1024) {
      return bytes + ' B';
    } else if (bytes < 1024 * 1024) {
      return (bytes / 1024).toFixed(1) + ' KB';
    } else {
      return (bytes / (1024 * 1024)).toFixed(1) + ' MB';
    }
  }
  
  /**
   * Format a date string to a more readable format
   * @param {string} dateString - ISO date string
   * @returns {string} - Formatted date string
   */
  function formatDate(dateString) {
    if (!dateString) return '';
    
    try {
      const date = new Date(dateString);
      const now = new Date();
      const diffMs = Number(now) - Number(date); // Convert to numbers for TypeScript
      const diffDays = Math.floor(diffMs / (1000 * 60 * 60 * 24));
      
      if (diffDays === 0) {
        return 'Today';
      } else if (diffDays === 1) {
        return 'Yesterday';
      } else if (diffDays < 7) {
        return `${diffDays} days ago`;
      } else if (diffDays < 30) {
        return `${Math.floor(diffDays / 7)} weeks ago`;
      } else if (diffDays < 365) {
        return `${Math.floor(diffDays / 30)} months ago`;
      } else {
        return `${Math.floor(diffDays / 365)} years ago`;
      }
    } catch (e) {
      return 'Unknown date';
    }
  }
</script>

<div class="mod-card" class:has-warnings={mod.warnings && mod.warnings.length > 0} class:has-update={hasUpdate}>
  <div class="mod-header-container">
    <ModCardHeader
      {mod}
      {expanded}
      {isInstalled}
      {hasUpdate}
      {updateVersionNumber}
      {installedVersionNumber}
      {selectedVersionId}
      {installedVersionId}
      {versions}
      toggleVersionSelector={toggleVersionSelector}
      getFirstChar={getFirstChar}
      formatDate={formatDate}
    />
    <ModCardActions
      {isInstalled}
      {isChangingVersion}
      {isInstalling}
      {hasUpdate}
      {expanded}
      {versions}
      {selectedVersionId}
      handleInstallClick={handleInstallClick}
    />
  </div>

  <ModCardBody
    {expanded}
    modId={mod.id}
    {loading}
    {error}
    {filteredVersions}
    {filterMinecraftVersion}
    {selectedVersionId}
    {installedVersionId}
    {versions}
    selectVersion={selectVersion}
    formatFileSize={formatFileSize}
  />
</div>

<style global>
  .mod-card {
    background: rgba(255, 255, 255, 0.07);
    border-radius: 8px;
    margin-bottom: 12px;
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
  
  .mod-header-container {
    display: flex;
    align-items: center;
  }
  
  .mod-header {
    display: flex;
    padding: 12px;
    position: relative;
    text-align: left;
    background: transparent;
    border: none;
    color: inherit;
    flex: 1;
    font-family: inherit;
    font-size: inherit;
    cursor: pointer;
  }
  
  .mod-icon-container {
    flex-shrink: 0;
    width: 48px;
    height: 48px;
    margin-right: 12px;
    border-radius: 6px;
    overflow: hidden;
    background: rgba(255, 255, 255, 0.1);
  }
  
  .mod-icon {
    width: 100%;
    height: 100%;
    object-fit: cover;
  }
  
  .mod-icon-placeholder {
    width: 100%;
    height: 100%;
    display: flex;
    align-items: center;
    justify-content: center;
    font-weight: bold;
    font-size: 20px;
    color: rgba(255, 255, 255, 0.8);
    background: linear-gradient(135deg, rgba(100, 108, 255, 0.5), rgba(100, 108, 255, 0.3));
  }
  
  .mod-details {
    flex: 1;
    min-width: 0; /* Fix for text overflow in flex items */
  }
  
  .mod-title {
    margin: 0 0 4px 0;
    font-size: 16px;
    font-weight: 600;
    color: rgba(255, 255, 255, 0.9);
    display: flex;
    align-items: center;
    gap: 6px;
  }
  
  .mod-description {
    margin: 0 0 8px 0;
    font-size: 14px;
    color: rgba(255, 255, 255, 0.7);
    line-height: 1.4;
    overflow: hidden;
    text-overflow: ellipsis;
    display: -webkit-box;
    -webkit-line-clamp: 2;
    line-clamp: 2; /* Standard property for compatibility */
    -webkit-box-orient: vertical;
  }
  
  .mod-meta {
    display: flex;
    flex-wrap: wrap;
    gap: 10px;
    font-size: 12px;
    color: rgba(255, 255, 255, 0.5);
  }
  
  .version-selector-toggle {
    border-bottom: 1px dotted rgba(255, 255, 255, 0.3);
    padding-bottom: 1px;
    display: inline-flex;
    align-items: center;
    gap: 4px;
  }
  
  .version-dropdown-icon {
    font-size: 10px;
    opacity: 0.7;
  }
  
  .mod-author {
    white-space: nowrap;
    overflow: hidden;
    text-overflow: ellipsis;
  }
  
  .mod-actions {
    display: flex;
    align-items: center;
    padding-right: 12px;
  }
  
  .install-button {
    white-space: nowrap;
    padding: 6px 14px;
    font-size: 14px;
    border-radius: 6px;
    border: none;
    background: #1bd96a;
    color: #000;
    font-weight: 600;
    cursor: pointer;
    transition: all 0.2s;
  }
  
  .install-button:hover:not(:disabled) {
    background: #0ec258;
    transform: translateY(-1px);
  }
  
  .install-button.installed {
    background: #4080ff;
    color: white;
  }
  
  .install-button.change-version {
    background: #ff9800;
    color: white;
  }
  
  .install-button.installing {
    background: #ff9800;
    color: white;
    animation: pulse 2s infinite;
  }
  
  .version-selector {
    padding: 12px;
    background: rgba(0, 0, 0, 0.3);
    border-top: 1px solid rgba(255, 255, 255, 0.1);
    max-height: 200px;
    overflow-y: auto;
  }
  
  .version-list {
    display: flex;
    flex-direction: column;
    gap: 6px;
  }
  
  .filter-notice {
    background: rgba(255, 152, 0, 0.1);
    border: 1px solid rgba(255, 152, 0, 0.3);
    border-radius: 4px;
    padding: 8px;
    margin-bottom: 8px;
    font-size: 12px;
    color: rgba(255, 255, 255, 0.8);
    text-align: center;
  }
  
  .filter-toggle {
    display: block;
    margin: 5px auto 0;
    padding: 2px 8px;
    background: rgba(255, 152, 0, 0.2);
    border: 1px solid rgba(255, 152, 0, 0.4);
    border-radius: 4px;
    color: rgba(255, 255, 255, 0.9);
    font-size: 12px;
    cursor: pointer;
    transition: all 0.2s;
  }
  
  .filter-toggle:hover {
    background: rgba(255, 152, 0, 0.3);
  }
  
  .version-item {
    display: flex;
    justify-content: space-between;
    align-items: center;
    padding: 8px 10px;
    border-radius: 4px;
    background: rgba(255, 255, 255, 0.05);
    cursor: pointer;
    transition: background-color 0.15s;
    text-align: left;
    width: 100%;
    border: none;
    font-family: inherit;
    font-size: inherit;
    color: inherit;
  }
  
  .version-item:hover {
    background: rgba(255, 255, 255, 0.1);
  }
  
  .version-item.selected {
    background: rgba(100, 108, 255, 0.2);
    border-left: 3px solid #646cff;
  }
  
  .version-item.installed-version {
    border-left: 3px solid #4080ff;
    background: rgba(64, 128, 255, 0.1);
  }
  
  .version-item.compatible {
    border-left-color: #4caf50;
    border-left-width: 3px;
    background: rgba(76, 175, 80, 0.1);
  }
  
  .version-name {
    font-size: 14px;
    color: rgba(255, 255, 255, 0.8);
  }
  
  .version-mc {
    font-size: 12px;
    color: rgba(255, 255, 255, 0.5);
    margin-left: 6px;
  }
  
  .version-info {
    display: flex;
    flex-direction: column;
    gap: 2px;
  }
  
  .version-meta {
    display: flex;
    flex-direction: column;
    align-items: flex-end;
    gap: 2px;
    font-size: 12px;
    color: rgba(255, 255, 255, 0.5);
  }
  
  .loading-versions, .no-versions, .version-error {
    text-align: center;
    padding: 10px;
    color: rgba(255, 255, 255, 0.7);
    font-size: 14px;
  }
  
  .version-error {
    color: #ff6b6b;
  }
  
  .show-all-versions {
    display: block;
    margin: 8px auto 0;
    padding: 4px 10px;
    background: rgba(100, 108, 255, 0.2);
    border: 1px solid rgba(100, 108, 255, 0.5);
    border-radius: 4px;
    color: rgba(255, 255, 255, 0.9);
    font-size: 12px;
    cursor: pointer;
    transition: all 0.2s;
  }
  
  .show-all-versions:hover {
    background: rgba(100, 108, 255, 0.3);
  }
  
  .warning-badge {
    display: inline-flex;
    color: #ff9800;
    cursor: help;
    font-size: 16px;
  }
  
  .has-warnings {
    border-left: 3px solid #ff9800;
  }
  
  .mod-icon.disabled,
  .mod-icon-placeholder.disabled {
    opacity: 0.5;
    filter: grayscale(70%);
  }
  
  .mod-title.disabled,
  .mod-description.disabled {
    opacity: 0.7;
  }
  
  .environment-badge {
    display: inline-flex;
    align-items: center;
    justify-content: center;
    margin-left: 6px;
    font-size: 12px;
    border-radius: 4px;
    padding: 0 4px;
    cursor: help;
  }
  
  .environment-badge.client {
    background: rgba(0, 128, 255, 0.2);
    color: rgba(0, 128, 255, 0.9);
  }
  
  .environment-badge.server {
    background: rgba(255, 64, 64, 0.2);
    color: rgba(255, 64, 64, 0.9);
  }
  
  .environment-badge.both {
    background: rgba(0, 192, 64, 0.2);
    color: rgba(0, 192, 64, 0.9);
  }
  
  @keyframes pulse {
    0% { opacity: 0.5; }
    50% { opacity: 1; }
    100% { opacity: 0.5; }
  }
  
  .version-tag-inline {
    font-size: 12px;
    color: #a0a8ff;
    margin-left: 4px;
  }
  
  .version-note {
    margin-bottom: 12px;
    font-size: 14px;
    color: rgba(255, 255, 255, 0.7);
    text-align: center;
  }
  
  .installed-badge {
    display: inline-block;
    margin-left: 8px;
    font-size: 11px;
    padding: 2px 6px;
    background: rgba(64, 128, 255, 0.2);
    color: rgba(255, 255, 255, 0.9);
    border-radius: 3px;
  }
  
  .has-update {
    border-left: 3px solid #1bd96a;
  }
  
  .update-badge {
    display: inline-flex;
    align-items: center;
    justify-content: center;
    margin-left: 6px;
    font-size: 12px;
    border-radius: 4px;
    padding: 0 6px;
    background: rgba(27, 217, 106, 0.2);
    color: #1bd96a;
    font-weight: 500;
  }
  
  .version-tag-inline.has-update {
    color: #1bd96a;
  }
  
  .update-available-tag {
    margin-left: 4px;
    color: #1bd96a;
    font-weight: 500;
  }
  
  .install-button.update-available {
    background: #1bd96a;
    color: black;
  }
  
  .install-button.update-available:hover {
    background: #0ec258;
  }
  
  .mod-stats {
    display: flex;
    flex-wrap: wrap;
    gap: 8px;
    margin-top: 6px;
    margin-bottom: 6px;
    font-size: 0.75rem;
    color: rgba(255, 255, 255, 0.6);
  }
  
  .mod-stat {
    display: flex;
    align-items: center;
    gap: 4px;
    background: rgba(255, 255, 255, 0.07);
    border-radius: 12px;
    padding: 2px 8px;
  }
  
  .stat-icon {
    font-style: normal;
    font-size: 0.8rem;
  }
</style> 