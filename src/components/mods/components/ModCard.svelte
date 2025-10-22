<!-- @ts-ignore -->
<script>  import { createEventDispatcher } from 'svelte';
  import { 
    installedModIds, 
    installingModIds, 
    expandedModId, 
    modsWithUpdates,
    installedModInfo,
    activeContentType,
    CONTENT_TYPES,
    installedShaders,
    installedResourcePacks,
    installedShaderIds,
    installedResourcePackIds,
    installedShaderInfo,
    installedResourcePackInfo
  } from '../../../stores/modStore.js';
  import { onMount } from 'svelte';
  
  // Props
  export let mod = {};
  export let expanded = false;
  export let versions = [];
  export let loading = false;
  export let error = null;
  export let filterMinecraftVersion = '';
  export let loadOnMount = false; // New flag to control whether to load versions on mount
  export let installedVersionId = ''; // ID of the currently installed version
  export let serverManaged = false; // True if this mod is managed by the server
  
  // Local state
  let selectedVersionId = mod.selectedVersionId || installedVersionId;
  let filteredVersions = [];
  let unfilteredVersions = []; // To store all stable versions
  let hasUpdate = false; // Add variable declaration for update status
  let updateInfo = null; // Add variable declaration for update information
  let updateVersionNumber = null; // Add variable declaration for update version number
  let isInstalled = false; // Add variable declaration for installed status
  let installedModData = null; // Add variable declaration for installed content data
  import { SvelteSet } from 'svelte/reactivity';
  
  let groupedVersions = {}; // Versions grouped by Minecraft version
  let expandedMcVersions = new SvelteSet(); // Track which MC versions are expanded
  // Helper to normalize names/ids for fuzzy matching
  function normalizeName(str) {
    if (!str || typeof str !== 'string') return '';
    return str
      .toLowerCase()
      .replace(/\.(zip|jar)$/g, '')
      .replace(/[^a-z0-9]+/g, '-')
      .replace(/^-+|-+$/g, '');
  }

  // Determine installed status based on active content type (with fallbacks for shaders/resource packs)
  $: {
    let installedIds;
    let installedInfoList;
    let installedFileList;
    switch ($activeContentType) {
      case CONTENT_TYPES.SHADERS:
        installedIds = $installedShaderIds;
        installedInfoList = $installedShaderInfo;
        installedFileList = $installedShaders;
        break;
      case CONTENT_TYPES.RESOURCE_PACKS:
        installedIds = $installedResourcePackIds;
        installedInfoList = $installedResourcePackInfo;
        installedFileList = $installedResourcePacks;
        break;
      case CONTENT_TYPES.MODS:
      default:
        installedIds = $installedModIds;
        installedInfoList = $installedModInfo;
        installedFileList = [];
        break;
    }

    // Primary: direct id/slug match in installed IDs
    let installed = installedIds.has(mod.id) || (mod.slug && installedIds.has(mod.slug));

    // Fallbacks for shaders/resource packs where IDs may be missing in installed set
    if (!installed && installedInfoList && installedInfoList.length > 0) {
      const targetSlug = normalizeName(mod.slug || '');
      const targetName = normalizeName(mod.name || mod.title || '');
      installed = installedInfoList.some((info) => {
        const infoById = info.projectId && (info.projectId === mod.id);
        if (infoById) return true;
        const infoName = normalizeName(info.name || info.fileName || '');
        return (targetSlug && infoName === targetSlug) || (targetName && infoName === targetName);
      });
    }

    // Fallback to filename-only match when no info list (common for shaders/resourcepacks)
    if (!installed && installedFileList && installedFileList.length > 0 && ($activeContentType !== CONTENT_TYPES.MODS)) {
      const installedBaseNames = installedFileList.map((f) => normalizeName(f));
      const targetSlug = normalizeName(mod.slug || '');
      const targetName = normalizeName(mod.name || mod.title || '');
      if (targetSlug) {
        installed = installedBaseNames.includes(targetSlug);
      }
      if (!installed && targetName) {
        installed = installedBaseNames.includes(targetName);
      }
    }

    isInstalled = installed;
  }
  $: isInstalling = $installingModIds.has(mod.id);
  $: isChangingVersion = isInstalled && selectedVersionId && selectedVersionId !== installedVersionId;
  
  
  // Get installed content information based on active content type
  $: {
    let installedInfoStore;
    switch ($activeContentType) {
      case CONTENT_TYPES.SHADERS:
        installedInfoStore = $installedShaderInfo;
        break;
      case CONTENT_TYPES.RESOURCE_PACKS:
        installedInfoStore = $installedResourcePackInfo;
        break;
      case CONTENT_TYPES.MODS:
      default:
        installedInfoStore = $installedModInfo;
        break;
    }
    installedModData = installedInfoStore.find(info => info.projectId === mod.id);
  }
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
  
  // Group versions by Minecraft version
  $: {
    if (filteredVersions.length > 0) {
      const grouped = {};
      filteredVersions.forEach(version => {
        if (version && version.gameVersions && version.gameVersions.length > 0) {
          version.gameVersions.forEach(mcVer => {
            if (!grouped[mcVer]) {
              grouped[mcVer] = [];
            }
            // Avoid duplicates
            if (!grouped[mcVer].find(v => v.id === version.id)) {
              grouped[mcVer].push(version);
            }
          });
        }
      });
      groupedVersions = grouped;
    } else {
      groupedVersions = {};
    }
  }
  
  // Filter versions based on selected Minecraft version
  $: {
    if (versions.length > 0) {
      // First, get all stable versions (non-alpha, non-beta)
      unfilteredVersions = versions.filter(v => v && v.isStable !== false);
      
      if (filterMinecraftVersion && filterMinecraftVersion !== "") {
        // Show versions compatible with selected Minecraft version
        // Use more lenient matching that includes versions likely to work
        const exactMatches = versions.filter(v => 
          v && v.gameVersions && v.gameVersions.includes(filterMinecraftVersion) && v.isStable !== false
        );
        
        // If we have exact matches, use those
        if (exactMatches.length > 0) {
          filteredVersions = exactMatches;
        } else {
          // For 1.21.x, try to match versions that might work even if not tagged
          const mcVersionParts = filterMinecraftVersion.split('.');
          if (mcVersionParts.length >= 2 && mcVersionParts[0] === '1') {
            const majorMinorPrefix = `${mcVersionParts[0]}.${mcVersionParts[1]}`;
            
            // Find versions that match the major.minor version or are broadly compatible
            const likelyCompatible = versions.filter(v => {
              if (!v || !v.gameVersions || v.isStable === false) return false;
              
              return v.gameVersions.some(gameVer => {
                if (!gameVer) return false;
                
                // Check for exact major.minor match (e.g., "1.21" matches "1.21.4")
                if (gameVer.startsWith(majorMinorPrefix)) return true;
                
                // Check for broader compatibility patterns
                // e.g., "1.21.x", "1.21+", "1.21-1.22"
                if (gameVer.includes(majorMinorPrefix)) return true;
                
                // For shaders/resource packs, be more lenient with version matching
                // Check if it's a recent version that might be compatible
                const gameVerParts = gameVer.split('.');
                if (gameVerParts.length >= 2 && gameVerParts[0] === mcVersionParts[0]) {
                  const gameMinor = parseInt(gameVerParts[1]);
                  const targetMinor = parseInt(mcVersionParts[1]);
                  // Allow versions within 2 minor versions (e.g., 1.19-1.21 for 1.21.4)
                  return Math.abs(gameMinor - targetMinor) <= 2;
                }
                
                return false;
              });
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
  $: if (versions.length > 0 && !selectedVersionId) {
    // If we're installed, try to select the installed version first
    if (isInstalled && installedVersionId) {
      const installedVersion = versions.find(v => v.id === installedVersionId);
      if (installedVersion) {
        selectedVersionId = installedVersionId;
      } else {
        // Use all versions to find the best one (not filtered by MC version)
        selectedVersionId = selectBestVersion(versions);
      }
    } else {
      // Use all versions to find the best one (not filtered by MC version)
      selectedVersionId = selectBestVersion(versions);
    }
    // Also update the mod object
    mod.selectedVersionId = selectedVersionId;
  }
  
  /**
   * Select the best version based on MC version (highest first), then stability and release date
   * @param {Array} versions - Available versions
   * @returns {string} - Version ID
   */
  function selectBestVersion(versions) {
    // Don't filter by current MC version - we want the version for the HIGHEST MC version available
    let compatibleVersions = versions;
    
    // Then try to find stable versions
    const stableVersions = compatibleVersions.filter(v => v && v.isStable !== false);
    const versionsToUse = stableVersions.length > 0 ? stableVersions : compatibleVersions;
    
    // Sort by Minecraft version (highest first), then by date (newest first)
    const sortedVersions = [...versionsToUse].sort((a, b) => {
      // Get the highest MC version for each mod version
      const getHighestMcVersion = (version) => {
        if (!version || !version.gameVersions || version.gameVersions.length === 0) return [0, 0, 0];
        
        // Parse all MC versions and find the highest
        const parsed = version.gameVersions.map(v => {
          const parts = v.split('.').map(Number);
          return [parts[0] || 0, parts[1] || 0, parts[2] || 0];
        });
        
        // Sort and return highest
        parsed.sort((x, y) => {
          if (x[0] !== y[0]) return y[0] - x[0];
          if (x[1] !== y[1]) return y[1] - x[1];
          return y[2] - x[2];
        });
        
        return parsed[0];
      };
      
      const mcVerA = getHighestMcVersion(a);
      const mcVerB = getHighestMcVersion(b);
      
      // Compare MC versions
      if (mcVerA[0] !== mcVerB[0]) return mcVerB[0] - mcVerA[0]; // Major
      if (mcVerA[1] !== mcVerB[1]) return mcVerB[1] - mcVerA[1]; // Minor
      if (mcVerA[2] !== mcVerB[2]) return mcVerB[2] - mcVerA[2]; // Patch
      
      // If MC versions are the same, sort by date
      const dateA = a && a.datePublished ? new Date(a.datePublished).getTime() : 0;
      const dateB = b && b.datePublished ? new Date(b.datePublished).getTime() : 0;
      return dateB - dateA;
    });
    
    // Return the ID of the first (newest) version
    return sortedVersions.length > 0 && sortedVersions[0] ? sortedVersions[0].id : null;
  }
  
  /**
   * Toggle MC version group expansion
   */
  function toggleMcVersion(mcVersion) {
    if (expandedMcVersions.has(mcVersion)) {
      expandedMcVersions.delete(mcVersion);
    } else {
      expandedMcVersions.add(mcVersion);
    }
    expandedMcVersions = expandedMcVersions; // Trigger reactivity
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
    if (serverManaged) {
      return;
    }
    if (expanded) {
      expandedModId.set(null);
    } else {
      expandedModId.set(mod.id);
      
      // Load all versions when expanding the mod card
      // This ensures we get the full version list when the user wants to see it
      dispatch('loadVersions', { modId: mod.id, loadAll: true });
    }  }
  
  // When the component is mounted, conditionally load versions
  onMount(() => {
    // Load all versions on mount to determine the best one by MC version
    if (loadOnMount && (!versions || versions.length === 0)) {
      dispatch('loadVersions', { modId: mod.id, loadLatestOnly: false, loadAll: true });
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
    if (serverManaged) {
      return;
    }
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

  /**
   * Generate webpage URL for content based on its source and type
   * @param {Object} mod - Content object (mod, shader, or resource pack)
   * @returns {string|null} - Webpage URL or null if not available
   */
  function getModWebpageUrl(mod) {
    if (!mod || !mod.source) return null;
    
    // Validate that we have the necessary identifiers
    const identifier = mod.slug || mod.id;
    if (!identifier) return null;
    
    if (mod.source === 'modrinth') {
      // Determine the content type path for Modrinth
      let contentPath = 'mod'; // default for mods
      switch ($activeContentType) {
        case CONTENT_TYPES.SHADERS:
          contentPath = 'shader';
          break;
        case CONTENT_TYPES.RESOURCE_PACKS:
          contentPath = 'resourcepack';
          break;
        case CONTENT_TYPES.MODS:
        default:
          contentPath = 'mod';
          break;
      }
      return `https://modrinth.com/${contentPath}/${identifier}`;
    } else if (mod.source === 'curseforge') {
      // Determine the content type path for CurseForge
      let contentPath = 'mc-mods'; // default for mods
      switch ($activeContentType) {
        case CONTENT_TYPES.SHADERS:
          contentPath = 'shaders';
          break;
        case CONTENT_TYPES.RESOURCE_PACKS:
          contentPath = 'texture-packs';
          break;
        case CONTENT_TYPES.MODS:
        default:
          contentPath = 'mc-mods';
          break;
      }
      return `https://www.curseforge.com/minecraft/${contentPath}/${identifier}`;
    }
    
    return null;
  }

  /**
   * Validate a URL before attempting to open it
   * @param {string} url - URL to validate
   * @returns {boolean} - Whether the URL is valid
   */
  function isValidUrl(url) {
    if (!url || typeof url !== 'string') return false;
    
    try {
      const urlObj = new URL(url);
      return urlObj.protocol === 'http:' || urlObj.protocol === 'https:';
    } catch {
      return false;
    }
  }

  /**
   * Handle opening mod webpage in external browser with enhanced error handling
   * @param {Object} mod - Mod object
   */
  function openModWebpage(mod) {
    const url = getModWebpageUrl(mod);
    
    if (!url) {
      // No URL available for mod
      // Show user feedback for missing URL
      if (window.electron && window.electron.invoke) {
        window.electron.invoke('show-error-dialog', {
          title: 'Webpage Not Available',
          message: `Unable to open webpage for "${mod?.name || 'this mod'}". The webpage URL is not available.`
        }).catch(() => {});
      }
      return;
    }

    // Validate URL before attempting to open
    if (!isValidUrl(url)) {
      // Invalid URL generated
      if (window.electron && window.electron.invoke) {
        window.electron.invoke('show-error-dialog', {
          title: 'Invalid Webpage URL',
          message: `The webpage URL for "${mod?.name || 'this mod'}" appears to be invalid.`
        }).catch(() => {});
      }
      return;
    }

    // Attempt to open URL with proper error handling
    if (window.electron && window.electron.invoke) {
      window.electron.invoke('open-external-url', url).catch(() => {
        // Failed to open external URL
        
        // Show user feedback for failed URL opening
        window.electron.invoke('show-error-dialog', {
          title: 'Failed to Open Webpage',
          message: `Unable to open the webpage for "${mod?.name || 'this mod'}". Please try again or visit the URL manually: ${url}`
        }).catch(() => {});
        
        // Attempt fallback to window.open
        try {
          window.open(url, '_blank');
        } catch {
          // Fallback window.open also failed
        }
      });
    } else {
      // Fallback for when electron is not available
      try {
        window.open(url, '_blank');
      } catch {
        // Failed to open URL with window.open
        // In non-electron environment, we can't show native dialogs
        alert(`Failed to open webpage: ${url}`);
      }
    }
  }
</script>

<div class="mod-card" class:has-warnings={mod.warnings && mod.warnings.length > 0} class:has-update={hasUpdate}>
  <div class="mod-header-container">
    <button 
      class="mod-header" 
      on:click={toggleVersionSelector}
      type="button"
      aria-expanded={expanded}
      aria-controls={`version-selector-${mod.id}`}
    >
      <div class="mod-icon-container">
        {#if mod.iconUrl}
          <img 
            src={mod.iconUrl} 
            alt={mod.name} 
            class="mod-icon"
            on:error={() => mod.iconUrl = null} 
            class:disabled={isInstalled && !hasUpdate}
          />
        {:else}
          <div class="mod-icon-placeholder" class:disabled={isInstalled && !hasUpdate}>
            {getFirstChar(mod.name || mod.title)}
          </div>
        {/if}
      </div>
      
      <div class="mod-details">
        <h3 class="mod-title" class:disabled={isInstalled && !hasUpdate}>
          {mod.name || mod.title}
          
          {#if mod.clientSide && mod.serverSide}
            <span class="environment-badge both" title="Works on both client and server">C/S</span>
          {:else if mod.clientSide}
            <span class="environment-badge client" title="Client-side mod">Client</span>
          {:else if mod.serverSide}
            <span class="environment-badge server" title="Server-side mod">Server</span>
          {/if}
          
          {#if hasUpdate}
            <span class="update-badge" title="Update available">
              New Update
            </span>
          {/if}
          
          {#if mod.warnings && mod.warnings.length > 0}
            <span 
              class="warning-badge" 
              title={mod.warnings.join('\n')}
            >
              ⚠️
            </span>
          {/if}
        </h3>
        
        <p class="mod-description" class:disabled={isInstalled && !hasUpdate}>
          {mod.description || 'No description available'}
        </p>
        
        <div class="mod-stats">
          {#if mod.downloads !== undefined}
            <span class="mod-stat" title="Downloads">
              <i class="stat-icon download-icon">⬇️</i> {mod.downloads.toLocaleString()}
            </span>
          {/if}
          
          {#if mod.followers !== undefined}
            <span class="mod-stat" title="Followers">
              <i class="stat-icon follow-icon">⭐</i> {mod.followers.toLocaleString()}
            </span>
          {/if}
          
          {#if mod.lastUpdated}
            <span class="mod-stat" title="Last Updated">
              <i class="stat-icon updated-icon">🔄</i> {formatDate(mod.lastUpdated)}
            </span>
          {/if}
        </div>
        
        <div class="mod-meta">
          {#if mod.author}
            <span class="mod-author">by {mod.author}</span>
          {/if}
          
          {#if isInstalled}
            <!-- Show installed version info -->
            <span class="version-tag-inline" class:has-update={hasUpdate}>
              {installedVersionNumber || 'Installed'}
              {#if hasUpdate && updateVersionNumber}
                <span class="update-available-tag" title={`Update to ${updateVersionNumber} available`}>
                  ({updateVersionNumber} available)
                </span>
              {/if}
            </span>
          {:else if selectedVersionId && versions.length > 0}
            {@const selectedVersion = versions.find(v => v.id === selectedVersionId)}
            <span class="version-tag-inline">
              {selectedVersion ? selectedVersion.versionNumber : ''}
            </span>
          {/if}
        </div>
      </div>
    </button>
    
    <div class="mod-actions">
      {#if getModWebpageUrl(mod) && isValidUrl(getModWebpageUrl(mod))}
        <button
          class="webpage-button"
          title="View on {mod.source === 'modrinth' ? 'Modrinth' : mod.source === 'curseforge' ? 'CurseForge' : 'webpage'}"
          aria-label="View on {mod.source === 'modrinth' ? 'Modrinth' : mod.source === 'curseforge' ? 'CurseForge' : 'webpage'}"
          on:click={(e) => {
            e.stopPropagation();
            openModWebpage(mod);
          }}
          type="button"
        >
          <svg class="webpage-icon" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
            <path d="M18 13v6a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2V8a2 2 0 0 1 2-2h6"></path>
            <polyline points="15,3 21,3 21,9"></polyline>
            <line x1="10" y1="14" x2="21" y2="3"></line>
          </svg>
        </button>
      {:else if mod.source && (mod.source === 'modrinth' || mod.source === 'curseforge')}
        <!-- Show disabled button with explanation when URL should be available but isn't -->
        <button
          class="webpage-button disabled"
          title="Webpage not available for this {$activeContentType === CONTENT_TYPES.SHADERS ? 'shader' : $activeContentType === CONTENT_TYPES.RESOURCE_PACKS ? 'resource pack' : 'mod'}"
          aria-label="Webpage not available"
          disabled
          type="button"
        >
          <svg class="webpage-icon" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
            <path d="M18 13v6a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2V8a2 2 0 0 1 2-2h6"></path>
            <polyline points="15,3 21,3 21,9"></polyline>
            <line x1="10" y1="14" x2="21" y2="3"></line>
          </svg>
        </button>
      {/if}
      
      <button
        class="install-button"
        class:installed={isInstalled && (!isChangingVersion || !expanded) && !hasUpdate}
        class:update-available={isInstalled && hasUpdate && !expanded}
        class:change-version={isChangingVersion && expanded && !isInstalling}
        class:installing={isInstalling}
        disabled={serverManaged || isInstalling || (!isInstalled && versions.length > 0 && !selectedVersionId)}
        on:click={(e) => {
          e.stopPropagation();
          if (isInstalled) {
            if (expanded && isChangingVersion) {
              // If expanded and a different version is selected, trigger install with version change
              handleInstall(true);
            } else if (hasUpdate && !expanded) {
              // If there's an update available and not expanded, directly install the update
              // First, select the update version
              if (updateInfo && updateInfo.id) {
                selectVersion(updateInfo);
                // Then immediately install it
                handleInstall(true);
              } else {
                // If we don't have update info yet, load versions first
                toggleVersionSelector();
                dispatch('loadVersions', { modId: mod.id, loadAll: true });
              }
            } else {
              // Otherwise just expand to show version options
              toggleVersionSelector();
            }
          } else {
            // If not installed and we have versions, directly install the selected version
            if (versions && versions.length > 0 && selectedVersionId) {
              handleInstall();
            } else {
              // If versions aren't loaded yet, load them first
              toggleVersionSelector();
              // Try to fetch versions and auto-select the best one
              dispatch('loadVersions', { modId: mod.id, loadLatestOnly: true });
            }
          }
        }}
      >
        {#if serverManaged}
          {#if $activeContentType === CONTENT_TYPES.SHADERS}
            Server Shader
          {:else if $activeContentType === CONTENT_TYPES.RESOURCE_PACKS}
            Server Resource Pack
          {:else}
            Server Mod
          {/if}
        {:else if isInstalling}
          Installing...
        {:else if isInstalled}
          {#if expanded && isChangingVersion}
            Change Version
          {:else if hasUpdate}
            Update
          {:else}
            Installed
          {/if}
        {:else}
          Install
        {/if}
      </button>
    </div>
  </div>
  
  {#if expanded && !serverManaged}
    <div id="version-selector-{mod.id}" class="version-selector">
      {#if loading}
        <div class="loading-versions">Loading versions...</div>
      {:else if error}
        <div class="version-error">Error loading versions: {error}</div>
      {:else if filteredVersions.length === 0}
        <div class="no-versions">
          No compatible versions for Minecraft {filterMinecraftVersion}
        </div>
      {:else}
        <!-- Grouped by Minecraft version -->
        <div class="version-groups">
          {#each Object.keys(groupedVersions).sort((a, b) => {
            // Sort versions in descending order (newest first)
            const aParts = a.split('.').map(Number);
            const bParts = b.split('.').map(Number);
            for (let i = 0; i < Math.max(aParts.length, bParts.length); i++) {
              const aVal = aParts[i] || 0;
              const bVal = bParts[i] || 0;
              if (aVal !== bVal) return bVal - aVal;
            }
            return 0;
          }) as mcVersion (mcVersion)}
            {@const versionsForMc = groupedVersions[mcVersion]}
            {@const isExpanded = expandedMcVersions.has(mcVersion)}
            {@const isCurrent = mcVersion === filterMinecraftVersion}
            
            <div class="mc-version-group" class:current={isCurrent}>
              <button 
                class="mc-version-header" 
                on:click={() => toggleMcVersion(mcVersion)}
                type="button"
              >
                <span class="mc-version-icon">{isExpanded ? '▼' : '▶'}</span>
                <span class="mc-version-name">
                  📦 Minecraft {mcVersion}
                  {#if isCurrent}
                    <span class="current-badge">Current</span>
                  {/if}
                </span>
                <span class="mc-version-count">({versionsForMc.length} version{versionsForMc.length !== 1 ? 's' : ''})</span>
              </button>
              
              {#if isExpanded}
                <div class="version-list">
                  {#each versionsForMc as version (version.id)}
                    <div
                      class="version-item"
                      class:selected={version.id === selectedVersionId}
                      class:installed-version={version.id === installedVersionId}
                      aria-selected={version.id === selectedVersionId}
                    >
                      <div class="version-info">
                        <span class="version-name">{version.name || version.versionNumber}</span>
                        {#if version.id === installedVersionId}
                          <span class="installed-badge">Installed</span>
                        {/if}
                      </div>
                      <div class="version-meta">
                        {#if version.downloads !== undefined}
                          <span class="download-count" title="Download count">
                            {version.downloads.toLocaleString()} DL
                          </span>
                        {/if}
                        {#if version.fileSize !== undefined}
                          <span class="file-size" title="File size">
                            {formatFileSize(version.fileSize)}
                          </span>
                        {/if}
                      </div>
                      <button class="select-version" on:click={() => selectVersion(version)} type="button">
                        Select
                      </button>
                    </div>
                  {/each}
                </div>
              {/if}
            </div>
          {/each}
        </div>
      {/if}
    </div>
  {/if}
</div>

<style>
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
    color: rgba(255, 255, 255, 0.5);  }
  
  .mod-author {
    white-space: nowrap;
    overflow: hidden;
    text-overflow: ellipsis;
  }
  
  .mod-actions {
    display: flex;
    align-items: center;
    gap: 8px;
    padding-right: 12px;
  }

  .webpage-button {
    display: flex;
    align-items: center;
    justify-content: center;
    width: 32px;
    height: 32px;
    padding: 0;
    border: none;
    border-radius: 6px;
    background: rgba(255, 255, 255, 0.1);
    color: rgba(255, 255, 255, 0.7);
    cursor: pointer;
    transition: all 0.2s ease;
  }

  .webpage-button:hover:not(:disabled) {
    background: rgba(255, 255, 255, 0.2);
    color: rgba(255, 255, 255, 0.9);
    transform: translateY(-1px);
  }

  .webpage-button:disabled,
  .webpage-button.disabled {
    background: rgba(255, 255, 255, 0.05);
    color: rgba(255, 255, 255, 0.3);
    cursor: not-allowed;
    transform: none;
  }

  .webpage-button:disabled:hover,
  .webpage-button.disabled:hover {
    background: rgba(255, 255, 255, 0.05);
    color: rgba(255, 255, 255, 0.3);
    transform: none;
  }

  .webpage-icon {
    width: 16px;
    height: 16px;
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
  
  .version-groups {
    display: flex;
    flex-direction: column;
    gap: 8px;
  }
  
  .mc-version-group {
    border: 1px solid rgba(255, 255, 255, 0.1);
    border-radius: 6px;
    overflow: hidden;
    background: rgba(0, 0, 0, 0.2);
  }
  
  .mc-version-group.current {
    border-color: rgba(100, 108, 255, 0.4);
    background: rgba(100, 108, 255, 0.05);
  }
  
  .mc-version-header {
    display: flex;
    align-items: center;
    gap: 8px;
    width: 100%;
    padding: 10px 12px;
    background: rgba(255, 255, 255, 0.05);
    border: none;
    color: white;
    cursor: pointer;
    transition: background 0.2s;
    font-size: 0.95rem;
    text-align: left;
  }
  
  .mc-version-header:hover {
    background: rgba(255, 255, 255, 0.1);
  }
  
  .mc-version-icon {
    font-size: 0.8rem;
    width: 16px;
    display: inline-block;
  }
  
  .mc-version-name {
    flex: 1;
    font-weight: 500;
    display: flex;
    align-items: center;
    gap: 8px;
  }
  
  .mc-version-count {
    font-size: 0.85rem;
    opacity: 0.7;
  }
  
  .current-badge {
    background: #646cff;
    color: white;
    padding: 2px 6px;
    border-radius: 3px;
    font-size: 0.75rem;
    font-weight: 600;
  }
  
  .version-list {
    display: flex;
    flex-direction: column;
    gap: 6px;
    padding: 8px;
  }
  
  .version-item {
    display: flex;
    justify-content: space-between;
    align-items: center;
    padding: 8px 10px;
    border-radius: 4px;
    background: rgba(255, 255, 255, 0.05);
    transition: background-color 0.15s;
    text-align: left;
    width: 100%;
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
  
  .select-version {
    background: #646cff;
    color: white;
    border: none;
    padding: 0.25rem 0.5rem;
    border-radius: 4px;
    cursor: pointer;
  }

  .select-version:hover {
    background: #7a81ff;
  }
  
  .version-name {
    font-size: 14px;
    color: rgba(255, 255, 255, 0.8);
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
    color: #ff6b6b;  }
  
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