/**
 * Utilities for interacting with mod APIs and backend services
 */
import { safeInvoke } from '../ipcUtils.js';
import { get } from 'svelte/store';
import {
  installedMods,
  installedModInfo,
  installedModIds,
  searchResults,
  modVersionsCache,
  installedModVersionsCache,
  modsWithUpdates,
  isLoading,
  isSearching,
  isCheckingUpdates,
  errorMessage,
  successMessage,
  searchError,
  currentPage,
  totalPages,
  totalResults,
  serverConfig,
  minecraftVersion,
  loaderType,
  compareVersions,
  searchKeyword,
  modSource,
  resultsPerPage,
  filterModLoader,
  disabledMods,
  installingModIds,
  modCategories,
  disabledModUpdates
} from '../../stores/modStore.js';

// IDs to track concurrent operations
let loadId = 0;
let searchId = 0;
let updateCheckId = 0;

// Rate limiting protection
let lastSearchRequestTime = 0;
const MIN_SEARCH_INTERVAL = 500; // Minimum time between searches in ms

// Rate limiting protection for version fetching
let lastVersionFetchTime = 0;
const MIN_VERSION_FETCH_INTERVAL = 500; // Minimum time between version fetches in ms

/**
 * Load mods from the server directory
 * @param {string} serverPath - Path to the server
 * @returns {Promise<boolean>} - True if successful
 */
export async function loadMods(serverPath) {
  
  // Prevent concurrent loadMods calls
  if (get(isLoading)) {
    return false;
  }
  
  isLoading.set(true);
  const currentLoadId = ++loadId;
  
  try {
    if (!serverPath) {
      serverPath = await safeInvoke('get-last-server-path');
      if (!serverPath) {
        errorMessage.set('Server path not available');
        return false;
      }
    }
    
    const result = await safeInvoke('list-mods', serverPath);
    
    // Check if this is still the latest request
    if (currentLoadId !== loadId) {
      return false;
    }
    
    // Use the flat list of mod filenames for backward compatibility
    const modsList = result.modFiles || [];
    if (modsList.length === 0 && result.mods?.length > 0) {
      // Fallback to extracting filenames from the mods objects if modFiles is empty
      const extractedMods = result.mods.map(mod => mod.fileName);
      modsList.push(...extractedMods);
    }
    
    // Store all mods in the installedMods store
    installedMods.set(modsList);
    
    // Load existing saved categories first - with multiple attempts if needed
    const { loadModCategories } = await import('../../stores/modStore.js');
    
    // Try loading categories multiple times to ensure they're properly loaded
    let categoriesLoaded = false;
    for (let attempt = 0; attempt < 3; attempt++) {
      try {
        await loadModCategories();
        const currentCategories = get(modCategories);
        if (currentCategories.size > 0 || modsList.length === 0) {
          categoriesLoaded = true;
          break;
        }
        // Small delay before retry
        await new Promise(resolve => setTimeout(resolve, 100));
      } catch (error) {
        // TODO: Add proper logging - Category loading attempt failed
      }
    }
    
    // Get current categories to merge with new mod data
    let currentCategories = get(modCategories);
    
    // If we have mod data but no categories loaded, this indicates a persistence issue
    if (!categoriesLoaded && result.mods && result.mods.length > 0) {
      // TODO: Add proper logging - Failed to load saved categories, initializing from scan results
      currentCategories = new Map();
    }
    
    // Always update categories based on current file locations
    const updatedCategories = new Map();
    
    // First, preserve any existing category settings
    if (currentCategories.size > 0) {
      currentCategories.forEach((value, key) => {
        updatedCategories.set(key, { ...value });
      });
    }
    
    // Then update based on current file scan results
    result.mods?.forEach(mod => {
      const existingCategoryInfo = updatedCategories.get(mod.fileName);
      
      if (existingCategoryInfo) {
        // Existing mod - preserve saved settings but update category if file location changed
        updatedCategories.set(mod.fileName, {
          category: mod.category, // Update to match current file location
          required: existingCategoryInfo.required // Preserve saved requirement status
        });
      } else {
        // New mod not in saved categories - set defaults
        updatedCategories.set(mod.fileName, {
          category: mod.category,
          required: true // Default to required for new mods
        });
      }
    });
    
    // Remove categories for mods that no longer exist
    const currentModSet = new Set(modsList);
    const categoriesToRemove = [];
    updatedCategories.forEach((_, key) => {
      if (!currentModSet.has(key)) {
        categoriesToRemove.push(key);
      }
    });
    categoriesToRemove.forEach(key => updatedCategories.delete(key));
    
    // Update the store with the merged categories
    modCategories.set(updatedCategories);
    
    // Save updated categories to persistent storage
    try {
      const { saveModCategories } = await import('../../stores/modStore.js');
      await saveModCategories();
    } catch (error) {
      // TODO: Add proper logging - Failed to save updated mod categories
    }

    // Get installed mod IDs and version info
    try {
      // Clear existing installedModInfo to ensure we get fresh data
      installedModInfo.set([]);
      
      const modInfo = await safeInvoke('get-installed-mod-info', serverPath);
      
      // Check again if this is still the latest request
      if (currentLoadId !== loadId) {
        return false;
      }
        // Process installed mod info to ensure we have version IDs and proper data
      const modVersionsFromCache = get(installedModVersionsCache);
      const updatedModInfo = modInfo.map(info => {
        // Ensure we have a clean object with all necessary properties
        const cleanInfo = {
          fileName: info.fileName,
          projectId: info.projectId || null,
          versionId: info.versionId || null,
          versionNumber: info.versionNumber || null,
          name: info.name || (info.fileName ? info.fileName.replace(/\.jar$/i, '') : null),
          source: info.source || 'modrinth'
        };

        if (cleanInfo.projectId) {
          // If we have cached version info, match version number to version ID
          if (modVersionsFromCache[cleanInfo.projectId] && cleanInfo.versionNumber) {
            const versions = modVersionsFromCache[cleanInfo.projectId];
            const matchingVersion = versions.find(v => v.versionNumber === cleanInfo.versionNumber);
            if (matchingVersion) {
              cleanInfo.versionId = matchingVersion.id;
            }
          }
        }
        return cleanInfo;
      });
      
      // Update stores with clean, properly structured data
      const validProjectIds = new Set(updatedModInfo.map(info => info.projectId).filter(Boolean));
      installedModIds.set(validProjectIds);
      installedModInfo.set(updatedModInfo);
      
      // Automatically check for updates after loading mods
      setTimeout(() => {
        checkForUpdates(serverPath)
      }, 500);
        return true;
    } catch (err) {
      // TODO: Add proper logging - Error getting mod info
      // Continue without installed mod IDs, still consider this a success
      return true;
    }
  } catch (err) {
    // TODO: Add proper logging - Fatal error in loadMods
    errorMessage.set(`Failed to load mods: ${err.message || 'Unknown error'}`);
    return false;
  } finally {
    isLoading.set(false);
  }
}

/**
 * Load server configuration
 * @param {string} serverPath - Path to the server
 * @returns {Promise<Object|null>} - Server configuration or null if failed
 */
export async function loadServerConfig(serverPath) {
  try {
    if (!serverPath) {
      return null;
    }
    
    const config = await safeInvoke('read-config', serverPath);
    
    serverConfig.set(config);
    
    if (config) {
      // Update Minecraft version and loader type from config
      if (config.version) {
        minecraftVersion.set(config.version);
      }
      
      if (config.loader) {
        loaderType.set(config.loader);
      }
    }
    
    return config;
  } catch (err) {
    errorMessage.set(`Failed to load server config: ${err.message || 'Unknown error'}`);
    return null;
  }
}

/**
 * Search for mods
 * @param {Object} [options={}] - Search options object
 * @param {string} [options.sortBy] - Sort by parameter (relevance, downloads, follows, newest, updated)
 * @param {string} [options.environmentType] - Filter by environment (e.g. 'all', 'client', 'server')
 * @returns {Promise<Object>} - Search results object
 */
export async function searchMods(options = {}) {
  if (get(isSearching)) {
    return null;
  }
  
  // Rate limiting protection
  const now = Date.now();
  if (now - lastSearchRequestTime < MIN_SEARCH_INTERVAL) {
    await new Promise(resolve => setTimeout(resolve, MIN_SEARCH_INTERVAL - (now - lastSearchRequestTime)));
  }
  lastSearchRequestTime = Date.now();
  
  isSearching.set(true);
  searchError.set('');
  const currentSearchId = ++searchId;
  
  try {
    // Read filters from the centralized stores
    const query = get(searchKeyword);
    const source = get(modSource);
    // Always use the current Minecraft version, not the filter value
    const currentMinecraftVer = get(minecraftVersion);
    const loader = get(filterModLoader) || get(loaderType);
    const page = get(currentPage);
    const limit = get(resultsPerPage);
    const sortBy = options.sortBy || 'relevance';
    const environmentType = options.environmentType || 'all';
    
    
    const invokeArgs = {
      keyword: query,
      source,
      loader,
      version: currentMinecraftVer, // Always include the current Minecraft version
      page,
      limit,
      sortBy,
      environmentType // Include the environment filter
    };
    

    const result = await safeInvoke('search-mods', invokeArgs);
    
    if (currentSearchId !== searchId) {
      return null;
    }
    
    if (result && result.mods) {
      const installedModIdsSet = get(installedModIds);
      const mods = result.mods.map(mod => ({
        ...mod,
        isInstalled:
          installedModIdsSet.has(mod.id) ||
          (mod.slug && installedModIdsSet.has(mod.slug))
      }));
      searchResults.set(mods);
      if (result.pagination) {
        totalResults.set(result.pagination.totalResults || mods.length);
        totalPages.set(result.pagination.totalPages || Math.ceil(mods.length / limit));
        if (result.pagination.currentPage !== page) {
        currentPage.set(result.pagination.currentPage || page);
        }
      } else {
        totalResults.set(mods.length);
        totalPages.set(1);
        currentPage.set(page);
      }
      return {
        hits: mods,
        totalHits: result.pagination?.totalResults || mods.length,
        totalPages: result.pagination?.totalPages || 1
      };
    } else {
      searchResults.set([]);
      totalResults.set(0);
      totalPages.set(1);
      currentPage.set(1);
      if (result && result.error) {
        searchError.set(result.error);
      }
      return { hits: [], totalHits: 0, totalPages: 1 };
    }
  } catch (err) {
    searchError.set(`Search failed: ${err.message || 'Unknown error'}`);
    searchResults.set([]);
    return { hits: [], totalHits: 0, totalPages: 1, error: err.message };
  } finally {
    isSearching.set(false);
  }
}

/**
 * Fetch versions for a mod
 * @param {string} modId - Mod ID
 * @param {string} source - Source ('modrinth' or 'curseforge')
 * @param {boolean} loadLatestOnly - Whether to only load the latest version
 * @param {boolean} forceRefresh - Whether to bypass cache and fetch fresh data
 * @returns {Promise<Array>} - Array of version objects
*/
export async function fetchModVersions(modId, source = 'modrinth', loadLatestOnly = false, forceRefresh = false) {
  // Cache key
  const loader = get(loaderType);
  const gameVersion = get(minecraftVersion);
  const cacheKey = `${modId}:${loader}:${gameVersion}:${loadLatestOnly}:${forceRefresh}`;
  
  // Check if we already have this version information cached (unless forcing refresh)
  if (!forceRefresh) {
  const versionCache = get(modVersionsCache);
  if (versionCache[cacheKey] && versionCache[cacheKey].length > 0) {
    return versionCache[cacheKey];
    }
    }
    
  // Apply rate limiting to avoid hitting API limits
  const now = Date.now();
  if (now - lastVersionFetchTime < MIN_VERSION_FETCH_INTERVAL) {
    await new Promise(resolve => setTimeout(resolve, MIN_VERSION_FETCH_INTERVAL - (now - lastVersionFetchTime)));
  }
  lastVersionFetchTime = Date.now();
  
  try {
    const invokeArgs = {
      modId,
      source,
      loader,
      mcVersion: gameVersion,
      loadLatestOnly: loadLatestOnly,
      forceRefresh: forceRefresh
    };
    
    // Invoke the IPC method to get versions
    const versions = await safeInvoke('get-mod-versions', invokeArgs);
    
    if (!versions || versions.length === 0) {
      return [];
    }
    
    // Update the cache
    modVersionsCache.update(cache => {
      cache[cacheKey] = versions;
      return cache;
    });    
    return versions;
  } catch {
    
    // Return empty array on error
    return [];
  }
}

/**
 * Install a mod from a source
 * @param {Object} mod - Mod object with source, id, title
 * @param {string} serverPath - Server path
 * @returns {Promise<boolean>} Success status
 */
export async function installMod(mod, serverPath) {
  try {
    if (!mod || !mod.id) {
      throw new Error('Invalid mod data');
    }
    
    // Update installing state
    installingModIds.update(ids => {
      ids.add(mod.id);
      return ids;
    });
    
    // When updating a version, we need to explicitly tell the backend
    // to look for and remove any existing version first
    const isVersionUpdate = Boolean(mod.selectedVersionId);
    
    // Prepare mod data for installation
    const modData = {
      ...mod,
      // Make sure we set the loader and version if they're not already set
      loader: mod.loader || get(loaderType),
      version: mod.version || get(minecraftVersion),
      forceReinstall: isVersionUpdate // Tell backend to replace existing version
    };
    
    // Install the mod
    const result = await safeInvoke('install-mod', serverPath, modData);
    
    // Handle result
    if (result && result.success) {
      // Success!
      successMessage.set(`Successfully installed ${mod.title || mod.name}`);
      
      // Reload the installed mods list
      await loadMods(serverPath);
      
      // Clear the success message after a delay
      setTimeout(() => {
        successMessage.set('');
      }, 3000);
      
      return true;
    } else {
      // Installation failed
      throw new Error(result.error || 'Unknown error during installation');
    }
  } catch (error) {
    // TODO: Add proper logging
    errorMessage.set(`Failed to install mod: ${error.message}`);
    return false;
  } finally {
    // Always update the installing state
    installingModIds.update(ids => {
      ids.delete(mod.id);
      return ids;
    });
  }
}

/**
 * Delete a mod
 * @param {string} modName - Mod name/filename
 * @param {string} serverPath - Server path
 * @param {boolean} shouldReload - Whether to reload mods after deletion
 * @returns {Promise<boolean>} - True if successful
 */
export async function deleteMod(modName, serverPath, shouldReload = true) {
  try {
    if (!modName || !serverPath) {
      errorMessage.set('Invalid mod name or server path for deletion');
      return false;
    }
    
    const result = await safeInvoke('delete-mod', serverPath, modName);
    
    // Handle new response format with enhanced feedback
    if (result === true || (result && result.success)) {
      let message = `Successfully deleted ${modName}`;
      
      // Provide additional feedback based on the deletion result
      if (result && result.deletedFrom) {
        if (result.deletedFrom === 'not_found') {
          message = `${modName} was not found (may have been already deleted)`;
        } else if (Array.isArray(result.deletedFrom)) {
          // Multiple locations deleted
          if (result.deletedFromCount > 1) {
            const locations = result.deletedFrom.map(path => {
              if (path.includes('client')) return 'client';
              if (path.includes('disabled')) return 'disabled';
              return 'server';
            });
            message = `Successfully deleted ${modName} from ${locations.join(' and ')} folders`;
          } else {
            // Single location
            const path = result.deletedFrom[0];
            if (path.includes('client')) {
              message = `Successfully deleted ${modName} from client folder`;
            } else if (path.includes('disabled')) {
              message = `Successfully deleted ${modName} from disabled folder`;
            }
          }
        } else if (typeof result.deletedFrom === 'string') {
          // Legacy single path format
          if (result.deletedFrom.includes('client')) {
            message = `Successfully deleted ${modName} from client folder`;
          } else if (result.deletedFrom.includes('disabled')) {
            message = `Successfully deleted ${modName} from disabled folder`;
          }
        }
      }
      
      successMessage.set(message);
      
      if (shouldReload) {
        await loadMods(serverPath);
      }
      
      // Clear success message after a delay
      setTimeout(() => {
        successMessage.set('');
      }, 3000);
      
      return true;
    } else {
      errorMessage.set(`Failed to delete ${modName}: ${result?.error || 'Unknown error'}`);
      return false;
    }
  } catch (err) {
    errorMessage.set(`Failed to delete ${modName}: ${err.message || 'Unknown error'}`);
    return false;
  }
}

/**
 * Check for updates for installed mods
 * @param {string} serverPath - Server path
 * @param {boolean} forceRefresh - Whether to bypass cache and fetch fresh data
 * @returns {Promise<Map<string, Object>>} - Map of mod names to update info
 */
export async function checkForUpdates(serverPath, forceRefresh = false) {
  // Prevent concurrent update checks
  if (get(isCheckingUpdates)) {
    return new Map();
  }

  isCheckingUpdates.set(true);
  const currentCheckId = ++updateCheckId;
  
  const updatesMap = new Map();
  
  try {
    if (!serverPath) {
      isCheckingUpdates.set(false);
      return updatesMap;
    }
    
    // If forcing refresh, clear the version cache
    if (forceRefresh) {
      modVersionsCache.set({});
    }
    
    // Skip update check if no mods have project IDs
    const modsInfo = get(installedModInfo);
    const disabledModsSet = get(disabledMods);
    const modsWithProjectIds = modsInfo.filter(m => m.projectId && !disabledModsSet.has(m.fileName));
    
    if (modsWithProjectIds.length === 0) {
      modsWithUpdates.set(new Map());
    }
    
    // Check for disabled mod updates in parallel
    checkDisabledModUpdates(serverPath);
    
    for (const modInfo of modsWithProjectIds) {
      // Check if a newer update check has started
      if (currentCheckId !== updateCheckId) {
        break;
      }
      
      if (modInfo.projectId) {
        try {
          // Always fetch fresh versions to check for updates
          // This ensures we detect if a user has installed an older version
          const versions = await fetchModVersions(modInfo.projectId, 'modrinth', false, forceRefresh);
          
          // Update cache
          installedModVersionsCache.update(cache => {
            cache[modInfo.projectId] = versions;
            return cache;
          });
          
          // Check if an update is available
          const updateVersion = checkForUpdate(modInfo, versions);
          if (updateVersion) {
            // Only add the filename to the updates map for display
            // This ensures we don't double-count updates
            updatesMap.set(modInfo.fileName, updateVersion);
            
            // Store the project ID separately for reference in the Find Mods tab
            // We'll use a special prefix to distinguish it from actual mod filenames
            updatesMap.set(`project:${modInfo.projectId}`, updateVersion);
          }
        } catch {
          // Silently skip this mod
        }
      }
    }
    
    // Update the store
    modsWithUpdates.set(updatesMap);
    return updatesMap;
  } catch {
    return updatesMap;
  } finally {
    isCheckingUpdates.set(false);
  }
}

/**
 * Check for updates available for disabled mods
 * @param {string} serverPath - Server path
 */
export async function checkDisabledModUpdates(serverPath) {
  try {
    const mcVersion = get(minecraftVersion);
    
    if (!mcVersion || !serverPath) {
      disabledModUpdates.set(new Map());
      return;
    }
    
    // Call the new backend handler to check disabled mod updates
    const results = await safeInvoke('check-disabled-mod-updates', {
      serverPath,
      mcVersion
    });
    
    if (!results || !Array.isArray(results)) {
      disabledModUpdates.set(new Map());
      return;
    }
    
    // Filter for mods that have compatible updates available
    const disabledUpdatesMap = new Map();
    
    for (const result of results) {
      if (result.isCompatibleUpdate && result.hasUpdate) {
        disabledUpdatesMap.set(result.fileName, {
          projectId: result.projectId,
          currentVersion: result.currentVersion,
          latestVersion: result.latestVersion,
          latestVersionId: result.latestVersionId,
          reason: result.reason,
          name: result.name
        });
      }
    }
    disabledModUpdates.set(disabledUpdatesMap);
    
  } catch (error) {
    // TODO: Add proper logging - Failed to check disabled mod updates
    disabledModUpdates.set(new Map());
  }
}

/**
 * Enable and update a disabled mod to a newer compatible version
 * @param {string} serverPath - Server path
 * @param {string} modFileName - The disabled mod filename
 * @param {string} projectId - Modrinth project ID
 * @param {string} targetVersion - Target version number
 * @param {string} targetVersionId - Target version ID
 * @returns {Promise<boolean>} - Success status
 */
export async function enableAndUpdateMod(serverPath, modFileName, projectId, targetVersion, targetVersionId) {
  try {
    const result = await safeInvoke('enable-and-update-mod', {
      serverPath,
      modFileName,
      projectId,
      targetVersion,
      targetVersionId
    });
    
    if (result.success) {
      // Remove from disabled mod updates since it's now enabled and updated
      disabledModUpdates.update(updates => {
        const newUpdates = new Map(updates);
        newUpdates.delete(modFileName);
        return newUpdates;
      });
      
      // Remove from disabled mods store
      disabledMods.update(mods => {
        const newMods = new Set(mods);
        newMods.delete(modFileName);
        return newMods;
      });
      
      // Force reload the mod list to get the latest information
      await loadMods(serverPath);
      
      successMessage.set(`${modFileName} successfully enabled and updated to ${targetVersion}`);
      setTimeout(() => successMessage.set(''), 3000);
      
      return true;
    } else {
      errorMessage.set(`Failed to enable and update mod: ${result.error}`);
      setTimeout(() => errorMessage.set(''), 5000);
      return false;
    }
    
  } catch (error) {
    errorMessage.set(`Error enabling and updating mod: ${error.message}`);
    setTimeout(() => errorMessage.set(''), 5000);
    return false;
  }
}

/**
 * Check if a mod has an update available
 * @param {Object} modInfo - Installed mod info
 * @param {Array} versions - Available versions
 * @returns {Object|null} - The update version or null
 */
function checkForUpdate(modInfo, versions) {
  if (!versions || versions.length === 0 || !modInfo || !modInfo.versionNumber) {
    return null;
  }
  
  // Find stable versions for this MC version
  const stableVersions = versions.filter(v => v.isStable !== false);
  
  // If no stable versions, use any version
  const versionsToCheck = stableVersions.length > 0 ? stableVersions : versions;
  
  // Sort versions by date (newest first)
  const sortedVersions = [...versionsToCheck].sort((a, b) => {
    const dateA = new Date(a.datePublished).getTime();
    const dateB = new Date(b.datePublished).getTime();
    return dateB - dateA;
  });
  
  // Get the latest version
  const latestVersion = sortedVersions[0];
  
  // If the latest version is newer than the installed version
  if (latestVersion && latestVersion.versionNumber !== modInfo.versionNumber) {
    // Check if the latest version is actually newer using semantic versioning
    const versionComparison = compareVersions(latestVersion.versionNumber, modInfo.versionNumber);
    
    if (versionComparison > 0) {
      return latestVersion;
    }
  }
  
  return null;
} 