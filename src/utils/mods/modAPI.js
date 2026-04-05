/**
 * Utilities for interacting with mod APIs and backend services
 */
import { safeInvoke } from '../ipcUtils.js';
import { get } from 'svelte/store';
import { SvelteSet } from 'svelte/reactivity';
import logger from '../logger.js';
import {
  installedMods,
  installedModInfo,
  installedModIds,
  filterMinecraftVersion,
  searchResults,
  modVersionsCache,
  installedModVersionsCache,
  modsWithUpdates,
  isLoading,
  isSearching,
  isCheckingUpdates,
  updateCheckProgress,
  errorMessage,
  successMessage,
  searchError,
  currentPage,
  totalPages,
  totalResults,
  serverConfig,
  minecraftVersion,
  loaderType,
  searchKeyword,
  modSource,
  resultsPerPage,
  filterModLoader,
  disabledMods,
  installingModIds,
  modCategories,
  loadModCategories,
  saveModCategories,
  disabledModUpdates,
  installedShaders,
  installedShaderIds,
  installedShaderInfo,
  installedResourcePacks,
  installedResourcePackIds,
  installedResourcePackInfo,
  shaderResults,
  resourcePackResults,
  contentTypeSwitching,
  contentTypeCache,
  contentTypeRetryCount,
  contentTypeConfigs,
  isUpdateIgnored,
  lastUpdateCheckTime,
  autoUpdateChecksEnabled,
  DOWNLOAD_SOURCES
} from '../../stores/modStore.js';
import { trackDownload, completeDownload } from './modDownloadManager.js';

// IDs to track concurrent operations
let searchId = 0;
let updateCheckId = 0;
// Track a pending update check request if one comes in while a check is running
let pendingUpdateCheck = null;
let pendingSearchRequest = null;
let lastUpdateCheckPath = '';

// Rate limiting protection
let lastSearchRequestTime = 0;
const MIN_SEARCH_INTERVAL = 500; // Minimum time between searches in ms

// Rate limiting protection for version fetching
let lastVersionFetchTime = 0;
const MIN_VERSION_FETCH_INTERVAL = 500; // Minimum time between version fetches in ms
const normalizePathForUpdates = (p) => (typeof p === 'string' ? p.trim().toLowerCase() : '');
let activeContentLoads = 0;
let activeModServerPath = '';
let activeUpdateServerPath = '';
const latestLoadRequestByType = new Map();

function normalizeRequestedContentTypes(contentTypes) {
  if (!Array.isArray(contentTypes) || contentTypes.length === 0) {
    return null;
  }

  const normalizedTypes = Array.from(
    new Set(
      contentTypes
        .map((contentType) => String(contentType || '').trim().toLowerCase())
        .filter((contentType) => Object.values(contentTypeConfigs).some((config) => config.id === contentType))
    )
  );

  return normalizedTypes.length > 0 ? normalizedTypes : null;
}

function mergeUpdateCheckOptions(currentOptions = {}, nextOptions = {}) {
  const currentContentTypes = normalizeRequestedContentTypes(currentOptions.contentTypes);
  const nextContentTypes = normalizeRequestedContentTypes(nextOptions.contentTypes);

  if (!currentContentTypes && !nextContentTypes) {
    return {};
  }

  if (!currentContentTypes) {
    return {
      contentTypes: nextContentTypes
    };
  }

  if (!nextContentTypes) {
    return {
      contentTypes: currentContentTypes
    };
  }

  return {
    contentTypes: Array.from(new Set([...currentContentTypes, ...nextContentTypes]))
  };
}

function normalizeContentLookupName(value) {
  return String(value || '')
    .toLowerCase()
    .replace(/\.(zip|jar)$/g, '')
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '');
}

function namesProbablyMatch(left, right) {
  if (!left || !right) {
    return false;
  }

  return left === right
    || (left.length >= 5 && right.length >= 5 && (left.startsWith(right) || right.startsWith(left)));
}

function getLookupNamesForContent(item) {
  const lookupNames = [
    item?.slug,
    item?.name,
    item?.title,
    item?.fileName
  ]
    .map(normalizeContentLookupName)
    .filter(Boolean);

  return lookupNames.filter((name, index) => lookupNames.indexOf(name) === index);
}

export function findInstalledContentEntry(item, { installedInfoList = [] } = {}) {
  if (!item || !Array.isArray(installedInfoList) || installedInfoList.length === 0) {
    return null;
  }

  const itemId = item.id || item.projectId || null;
  const lookupNames = getLookupNamesForContent(item);

  return installedInfoList.find((info) => {
    if (!info) {
      return false;
    }

    if (itemId && info.projectId === itemId) {
      return true;
    }

    const infoLookupNames = getLookupNamesForContent(info);
    return infoLookupNames.some((infoName) =>
      lookupNames.some((lookupName) => namesProbablyMatch(infoName, lookupName))
    );
  }) || null;
}

export function matchesInstalledContent(item, {
  installedIds = new Set(),
  installedInfoList = [],
  installedFilesList = []
} = {}) {
  if (!item) {
    return false;
  }

  const itemId = item.id || item.projectId || null;
  if (itemId && installedIds?.has?.(itemId)) {
    return true;
  }

  const itemSlug = item.slug || null;
  if (itemSlug && installedIds?.has?.(itemSlug)) {
    return true;
  }

  if (findInstalledContentEntry(item, { installedInfoList })) {
    return true;
  }

  const lookupNames = getLookupNamesForContent(item);
  return (Array.isArray(installedFilesList) ? installedFilesList : []).some((fileName) => {
    const normalizedFileName = normalizeContentLookupName(fileName);
    return lookupNames.some((lookupName) => namesProbablyMatch(normalizedFileName, lookupName));
  });
}

function getInstalledStateContext(contentType = 'mods') {
  switch (contentType) {
    case 'shaders':
      return {
        resultsStore: shaderResults,
        installedIds: get(installedShaderIds),
        installedInfoList: get(installedShaderInfo),
        installedFilesList: get(installedShaders)
      };
    case 'resourcepacks':
      return {
        resultsStore: resourcePackResults,
        installedIds: get(installedResourcePackIds),
        installedInfoList: get(installedResourcePackInfo),
        installedFilesList: get(installedResourcePacks)
      };
    case 'mods':
    default:
      return {
        resultsStore: searchResults,
        installedIds: get(installedModIds),
        installedInfoList: get(installedModInfo),
        installedFilesList: get(installedMods)
      };
  }
}

export function createInstallDownloadId(mod, contentType = 'mods') {
  const baseId = normalizeContentLookupName(
    mod?.id || mod?.projectId || mod?.slug || mod?.name || mod?.title || 'download'
  ) || 'download';
  return `${contentType}-${baseId}-${Date.now()}`;
}

function resolveDownloadSource(source) {
  switch (String(source || '').toLowerCase()) {
    case DOWNLOAD_SOURCES.MODRINTH:
      return DOWNLOAD_SOURCES.MODRINTH;
    case DOWNLOAD_SOURCES.CURSEFORGE:
      return DOWNLOAD_SOURCES.CURSEFORGE;
    default:
      return DOWNLOAD_SOURCES.SERVER;
  }
}

export function queueInstallDownload(mod, contentType = 'mods', options = {}) {
  const downloadId = options.downloadId || mod?.downloadId || createInstallDownloadId(mod, contentType);

  trackDownload(downloadId, mod?.title || mod?.name || 'Download', {
    source: resolveDownloadSource(options.source || mod?.source),
    maxAttempts: options.maxAttempts || 3,
    state: 'queued',
    statusMessage: options.statusMessage || 'Preparing install...'
  });

  return downloadId;
}

function normalizeConfigValue(value) {
  if (typeof value === 'string') {
    return value.trim();
  }
  if (value === null || value === undefined) {
    return '';
  }
  return String(value).trim();
}

function buildInstalledVersionCacheKey(projectId, contentType = 'mods', updateContext = null) {
  if (!projectId) {
    return null;
  }

  const normalizedContentType = contentType || 'mods';
  const normalizedLoader =
    normalizedContentType === 'mods'
      ? normalizeConfigValue(updateContext?.loader) || 'vanilla'
      : 'noloader';
  const normalizedVersion =
    normalizeConfigValue(updateContext?.gameVersion)
    || normalizeConfigValue(updateContext?.minecraftVersion)
    || 'all';

  return `${normalizedContentType}:${projectId}:${normalizedLoader}:${normalizedVersion}`;
}

function getInstalledVersionCacheEntry(cache, projectId, contentType = 'mods', updateContext = null) {
  const cacheKey = buildInstalledVersionCacheKey(projectId, contentType, updateContext);
  if (!cacheKey) {
    return null;
  }

  return cache[cacheKey] || null;
}

function setInstalledVersionCacheEntry(projectId, versions, contentType = 'mods', updateContext = null) {
  const cacheKey = buildInstalledVersionCacheKey(projectId, contentType, updateContext);
  if (!cacheKey) {
    return;
  }

  installedModVersionsCache.update(cache => ({
    ...cache,
    [cacheKey]: Array.isArray(versions) ? versions : []
  }));
}

export function setActiveModServerPath(serverPath) {
  activeModServerPath = normalizePathForUpdates(serverPath);
}

function isCurrentModServerPath(serverPath) {
  const normalized = normalizePathForUpdates(serverPath);
  if (!activeModServerPath) {
    return true;
  }
  return normalized === activeModServerPath;
}

function beginTrackedContentLoad(contentType) {
  const currentLoadId = (latestLoadRequestByType.get(contentType) || 0) + 1;
  latestLoadRequestByType.set(contentType, currentLoadId);
  activeContentLoads += 1;
  isLoading.set(true);
  return currentLoadId;
}

function finishTrackedContentLoad() {
  activeContentLoads = Math.max(0, activeContentLoads - 1);
  if (activeContentLoads === 0) {
    isLoading.set(false);
  }
}

function isLatestContentLoad(contentType, currentLoadId, serverPath) {
  return latestLoadRequestByType.get(contentType) === currentLoadId && isCurrentModServerPath(serverPath);
}

function createUpdateContext(serverPath, config = null) {
  const currentVersion = normalizeConfigValue(config?.version);
  return {
    serverPath,
    loader: normalizeConfigValue(config?.loader) || 'vanilla',
    minecraftVersion: currentVersion,
    gameVersion: currentVersion,
    useFilter: false
  };
}

function normalizeGameVersionList(value) {
  if (Array.isArray(value)) {
    return value
      .filter(Boolean)
      .map((entry) => String(entry).trim())
      .filter(Boolean);
  }
  if (typeof value === 'string' && value.trim()) {
    return [value.trim()];
  }
  return [];
}

function extractGameVersionHintsFromVersionString(value) {
  const raw = String(value || '').trim();
  if (!raw) return [];

  const hints = [];
  const addMatches = (regex) => {
    for (const match of raw.matchAll(regex)) {
      const candidate = match?.[1] ? String(match[1]).trim() : '';
      if (candidate && !hints.includes(candidate)) {
        hints.push(candidate);
      }
    }
  };

  // Some projects encode the MC branch after a "+" suffix, e.g. "...+1.21.11" or "...+26.1".
  addMatches(/\+(\d+\.\d+(?:\.\d+)?)/g);
  // Common loader-prefixed formats such as fabric-1.21.11-2.2.6 or forge-1.20.1-47.2.0.
  addMatches(/(?:fabric|forge|quilt|neoforge|neo)[-_](\d+\.\d+(?:\.\d+)?)/gi);
  // Explicit MC markers.
  addMatches(/(?:minecraft|mc)[-_ ]?(\d+\.\d+(?:\.\d+)?)/gi);

  return hints;
}

function getInstalledGameVersionHints(modInfo, installedEntry = null) {
  const installedVersionRaw = modInfo?.versionNumber || modInfo?.version || '';
  return [
    ...normalizeGameVersionList(installedEntry?.gameVersions),
    ...normalizeGameVersionList(modInfo?.gameVersions),
    ...normalizeGameVersionList(modInfo?.minecraftVersion),
    ...extractGameVersionHintsFromVersionString(installedVersionRaw)
  ].filter((entry, index, source) => source.indexOf(entry) === index);
}

function isInstalledBuildCompatibleWithContext(modInfo, updateContext, installedEntry = null) {
  const targetMc = normalizeConfigValue(updateContext?.minecraftVersion || updateContext?.gameVersion);
  if (!targetMc) {
    return true;
  }

  const installedGameVersions = getInstalledGameVersionHints(modInfo, installedEntry);
  if (installedGameVersions.length === 0) {
    return true;
  }

  return installedGameVersions.some((entry) => isGameVersionCompatible(targetMc, entry));
}

function normalizeInstalledInfoList(infoList, contentType, updateContext, modVersionsFromCache) {
  return (Array.isArray(infoList) ? infoList : []).map((info) => {
    const cleanInfo = {
      fileName: info.fileName,
      projectId: info.projectId || null,
      versionId: info.versionId || null,
      versionNumber: info.versionNumber || null,
      name: info.name || (info.fileName ? info.fileName.replace(/\.jar$/i, '') : null),
      source: info.source || 'modrinth',
      minecraftVersion: info.minecraftVersion || null,
      gameVersions: normalizeGameVersionList(info.gameVersions || info.minecraftVersion),
      depends: info.depends || null,
      installationDate: info.installationDate || info.installedAt || null,
      installedAt: info.installedAt || info.installationDate || null,
      lastUpdated: info.lastUpdated || null,
      clientSide: info.clientSide ?? info.client_side ?? null,
      serverSide: info.serverSide ?? info.server_side ?? null
    };

    if (cleanInfo.projectId) {
      const versions = getInstalledVersionCacheEntry(
        modVersionsFromCache,
        cleanInfo.projectId,
        contentType,
        updateContext
      );
      if (versions && cleanInfo.versionNumber) {
        const matchingVersion = versions.find(v => v.versionNumber === cleanInfo.versionNumber);
        if (matchingVersion) {
          cleanInfo.versionId = matchingVersion.id;
        }
      }
    }

    return cleanInfo;
  });
}

// Helper to decide if a Modrinth game version entry is compatible with the current server version
export function isGameVersionCompatible(targetVersion, candidateVersion) {
  if (!targetVersion || !candidateVersion) return false;
  const toParts = (v) => {
    const str = String(v || '').toLowerCase().trim();
    const nums = str.match(/\d+/g);
    if (!nums || nums.length < 2) return null; // need at least major.minor
    const [major, minor, patch] = nums.map((n) => parseInt(n, 10));
    return {
      major,
      minor,
      patch: Number.isFinite(patch) ? patch : null,
      raw: str,
    };
  };

  const target = toParts(targetVersion);
  const candidate = toParts(candidateVersion);
  if (!target || !candidate) return false;

  if (candidate.major !== target.major || candidate.minor !== target.minor) {
    return false;
  }

  const candStr = String(candidateVersion || '').toLowerCase().trim();
  const wildcardPatch =
    candStr.endsWith('.x') ||
    candStr.endsWith('.*');

  if (wildcardPatch) {
    return true;
  }

  if (candidate.patch === null) {
    return target.patch === null;
  }

  if (target.patch === null) {
    return false;
  }

  return candidate.patch === target.patch;
}

/**
 * Load content (mods, shaders, resource packs) from the server directory
 * @param {string} serverPath - Path to the server
 * @param {string} contentType - Content type ('mods', 'shaders', 'resourcepacks')
 * @returns {Promise<boolean>} - True if successful
 */
export async function loadContent(serverPath, contentType = 'mods') {
  const currentLoadId = beginTrackedContentLoad(contentType);
  
  try {
    if (!serverPath) {
      return false;
    }
    
    // Use appropriate IPC method based on content type
    let ipcMethod;
    switch (contentType) {
      case 'shaders':
        ipcMethod = 'list-shaders';
        break;
      case 'resourcepacks':
        ipcMethod = 'list-resourcepacks';
        break;
      case 'mods':
      default:
        ipcMethod = 'list-mods';
        break;
    }
    
    const result = await safeInvoke(ipcMethod, serverPath);
    
    // Check if this is still the latest request
    if (!isLatestContentLoad(contentType, currentLoadId, serverPath)) {
      return false;
    }
    
    // Use the flat list of content filenames
    const contentList = result.modFiles || result.shaderFiles || result.resourcePackFiles || [];
    if (contentList.length === 0 && result.mods?.length > 0) {
      // Fallback to extracting filenames from the content objects if files list is empty
      const extractedContent = result.mods.map(item => item.fileName);
      contentList.push(...extractedContent);
    }
    
    // Store content in the appropriate store based on content type
    switch (contentType) {
      case 'shaders': {
        installedShaders.set(contentList);
        
        // Extract project IDs and info from result.mods if available
        const shaderProjectIds = new SvelteSet();
        const shaderInfoList = [];
        
        if (result.mods && Array.isArray(result.mods)) {
          result.mods.forEach(item => {
            
            // Always add to info list, even without projectId
            const shaderInfo = {
              fileName: item.fileName || '',
              projectId: item.projectId || null,
              versionId: item.versionId || null,
              versionNumber: item.versionNumber || null,
              name: item.name || (item.fileName ? item.fileName.replace(/\.zip$/i, '') : null),
              source: item.source || 'modrinth',
              minecraftVersion: item.minecraftVersion || null,
              gameVersions: normalizeGameVersionList(item.gameVersions || item.minecraftVersion),
              installationDate: item.installationDate || item.installedAt || null,
              installedAt: item.installedAt || item.installationDate || null,
              lastUpdated: item.lastUpdated || null
            };
            shaderInfoList.push(shaderInfo);
            
            // Only add to project IDs if we have a valid project ID
            if (item.projectId || item.id) {
              const projectId = item.projectId || item.id;
              shaderProjectIds.add(projectId);
            }
          });
        }
        
        installedShaderIds.set(shaderProjectIds);
        installedShaderInfo.set(shaderInfoList);
  // (Removed automatic update check – now only manual button or interval triggers)
        break;
      }
      case 'resourcepacks': {
        installedResourcePacks.set(contentList);
        
        // Extract project IDs and info from result.mods if available
        const resourcePackProjectIds = new SvelteSet();
        const resourcePackInfoList = [];
        
        if (result.mods && Array.isArray(result.mods)) {
          result.mods.forEach(item => {
            
            // Always add to info list, even without projectId
            const resourcePackInfo = {
              fileName: item.fileName || '',
              projectId: item.projectId || null,
              versionId: item.versionId || null,
              versionNumber: item.versionNumber || null,
              name: item.name || (item.fileName ? item.fileName.replace(/\.zip$/i, '') : null),
              source: item.source || 'modrinth',
              minecraftVersion: item.minecraftVersion || null,
              gameVersions: normalizeGameVersionList(item.gameVersions || item.minecraftVersion),
              installationDate: item.installationDate || item.installedAt || null,
              installedAt: item.installedAt || item.installationDate || null,
              lastUpdated: item.lastUpdated || null
            };
            resourcePackInfoList.push(resourcePackInfo);
            
            // Only add to project IDs if we have a valid project ID
            if (item.projectId || item.id) {
              const projectId = item.projectId || item.id;
              resourcePackProjectIds.add(projectId);
            }
          });
        }
        
        installedResourcePackIds.set(resourcePackProjectIds);
        installedResourcePackInfo.set(resourcePackInfoList);
  // (Removed automatic update check – now only manual button or interval triggers)
        break;
      }
      case 'mods':
      default:
        installedMods.set(contentList);
        break;
    }
    
    // For mods, continue with the existing category and mod info logic
    if (contentType === 'mods') {
      const strictUpdateContext = createUpdateContext(
        serverPath,
        await loadServerConfig(serverPath, { syncStores: false })
      );
      if (!isLatestContentLoad(contentType, currentLoadId, serverPath)) {
        return false;
      }

      // Load existing saved categories first - with multiple attempts if needed
      
      // Try loading categories multiple times to ensure they're properly loaded
      let categoriesLoaded = false;
      for (let attempt = 0; attempt < 3; attempt++) {
        try {
          await loadModCategories();
          const currentCategories = get(modCategories);
          if (currentCategories.size > 0 || contentList.length === 0) {
            categoriesLoaded = true;
            break;
          }
          // Small delay before retry
          await new Promise(resolve => setTimeout(resolve, 100));
        } catch {
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
      result.mods?.forEach((mod) => {
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
      const currentModSet = new Set(contentList);
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
        await saveModCategories();
      } catch {
        // TODO: Add proper logging - Failed to save updated mod categories
      }

      // Get installed mod IDs and version info
      try {
        let modInfo = await safeInvoke('get-installed-mod-info', serverPath);
        if (!Array.isArray(modInfo)) {
          modInfo = [];
        }
        
        // Check again if this is still the latest request
        if (!isLatestContentLoad(contentType, currentLoadId, serverPath)) {
          return false;
        }
          // Process installed mod info to ensure we have version IDs and proper data
        const modVersionsFromCache = get(installedModVersionsCache);
        let updatedModInfo = normalizeInstalledInfoList(
          modInfo,
          contentType,
          strictUpdateContext,
          modVersionsFromCache
        );

        // If we got zero or mostly incomplete entries, perform one background refresh of manifests and re-read
        const needsRetry = updatedModInfo.length === 0 || updatedModInfo.every(i => !i.versionNumber && !i.versionId);
        if (needsRetry && serverPath) {
          try {
            // Trigger a lightweight list-mods first so manifests and jar paths are fully discovered
            await safeInvoke('list-mods', serverPath);
            const retryInfo = await safeInvoke('get-installed-mod-info', serverPath);
            if (Array.isArray(retryInfo)) {
              modInfo = retryInfo;
              updatedModInfo = normalizeInstalledInfoList(
                modInfo,
                contentType,
                strictUpdateContext,
                modVersionsFromCache
              );
            }
          } catch {
            // Ignore retry errors
          }
        }
        
        // Update stores with clean, properly structured data
        const validProjectIds = new SvelteSet(updatedModInfo.map(info => info.projectId).filter(Boolean));
  installedModIds.set(validProjectIds);
  installedModInfo.set(updatedModInfo);
  // Prime disabled mod updates automatically only when background checks are enabled.
  if (autoUpdateChecksEnabled.getForPath(serverPath)) {
    try { await checkDisabledModUpdates(serverPath, strictUpdateContext); } catch { /* ignore */ }
  }
        
  // (Removed automatic post-load auto update check – now only manual button or interval triggers)
          return true;
      } catch {
        // TODO: Add proper logging - Error getting mod info
        // Continue without installed mod IDs, still consider this a success
        return true;
      }
    }
    
    return true;
  } catch (err) {
    // TODO: Add proper logging - Fatal error in loadContent
    errorMessage.set(`Failed to load ${contentType}: ${err.message || 'Unknown error'}`);
    return false;
  } finally {
    finishTrackedContentLoad();
  }
}

/**
 * Load mods from the server directory
 * @param {string} serverPath - Path to the server
 * @returns {Promise<boolean>} - True if successful
 */
export async function loadMods(serverPath) {
  // Use the new loadContent function with 'mods' as the content type
  return await loadContent(serverPath, 'mods');
}

/**
 * Load server configuration
 * @param {string} serverPath - Path to the server
 * @returns {Promise<Object|null>} - Server configuration or null if failed
 */
export async function loadServerConfig(serverPath, options = {}) {
  const { syncStores = true } = options;
  try {
    if (!serverPath) {
      return null;
    }
    
    const config = await safeInvoke('read-config', serverPath);
    
    if (syncStores && isCurrentModServerPath(serverPath)) {
      serverConfig.set(config);
    
      if (config) {
        // Update Minecraft version and loader type from config
        if (config.version) {
          minecraftVersion.set(config.version);
          filterMinecraftVersion.set(config.version);
        }
        
        if (config.loader) {
          loaderType.set(config.loader);
          filterModLoader.set(config.loader);
        }
      }
    }
    
    return config;
  } catch (err) {
    errorMessage.set(`Failed to load server config: ${err.message || 'Unknown error'}`);
    return null;
  }
}

/**
 * Search for content (mods, shaders, resource packs)
 * @param {string} contentType - Content type ('mods', 'shaders', 'resourcepacks')
 * @param {Object} [options={}] - Search options object
 * @param {string} [options.sortBy] - Sort by parameter (relevance, downloads, follows, newest, updated)
 * @param {string} [options.environmentType] - Filter by environment (e.g. 'all', 'client', 'server')
 * @returns {Promise<Object>} - Search results object
 */
/**
 * Generate a cache key for content type search results
 * @param {string} contentType - Content type
 * @param {Object} options - Search options
 * @returns {string} - Cache key
 */
function generateCacheKey(contentType, options = {}) {
  const {
    serverPath,
    searchKeyword,
    modSource,
    filterMinecraftVersion,
    filterModLoader,
    currentPage,
    resultsPerPage,
    sortBy,
    environmentType
  } = options;

  return `${normalizePathForUpdates(serverPath) || 'global'}-${contentType}-${searchKeyword || ''}-${modSource || ''}-${filterMinecraftVersion || ''}-${filterModLoader || ''}-${currentPage || 1}-${resultsPerPage || 20}-${sortBy || 'relevance'}-${environmentType || 'all'}`;
}

/**
 * Check if cached results are still valid (within 5 minutes)
 * @param {Object} cacheEntry - Cache entry with timestamp
 * @returns {boolean} - Whether cache is valid
 */
function isCacheValid(cacheEntry) {
  if (!cacheEntry || !cacheEntry.timestamp) return false;
  const CACHE_DURATION = 5 * 60 * 1000; // 5 minutes
  return Date.now() - cacheEntry.timestamp < CACHE_DURATION;
}

export async function searchContent(contentType = 'mods', options = {}) {
  if (get(isSearching) && !options.__retrying) {
    pendingSearchRequest = {
      contentType,
      options: { ...options }
    };
    searchId += 1;
    return null;
  }

  // Import performance optimization stores
  
  // Set switching state
  contentTypeSwitching.set(true);
  
  try {
    const hasExplicitFilterMinecraftVersion = Object.prototype.hasOwnProperty.call(options, 'filterMinecraftVersion');
    const hasExplicitFilterModLoader = Object.prototype.hasOwnProperty.call(options, 'filterModLoader');
    const effectiveFilterMinecraftVersion = hasExplicitFilterMinecraftVersion
      ? options.filterMinecraftVersion
      : get(filterMinecraftVersion);
    const effectiveFilterModLoader = hasExplicitFilterModLoader
      ? options.filterModLoader
      : get(filterModLoader);
    const { resultsStore, installedIds, installedInfoList, installedFilesList } =
      getInstalledStateContext(contentType);

    // Generate cache key
    const cacheKey = generateCacheKey(contentType, {
      serverPath: options.serverPath || activeModServerPath || activeUpdateServerPath || '',
      searchKeyword: get(searchKeyword),
      modSource: get(modSource),
      filterMinecraftVersion: effectiveFilterMinecraftVersion,
      filterModLoader: effectiveFilterModLoader,
      currentPage: get(currentPage),
      resultsPerPage: get(resultsPerPage),
      ...options
    });

    // Check cache first
    const cache = get(contentTypeCache);
    const cachedResult = cache.get(cacheKey);
    
    if (cachedResult && isCacheValid(cachedResult)) {
      const cachedMods = (cachedResult.data.mods || []).map((mod) => ({
        ...mod,
        isInstalled: matchesInstalledContent(mod, {
          installedIds,
          installedInfoList,
          installedFilesList
        })
      }));

      resultsStore.set(cachedMods);
      
      // Update pagination from cache
      if (cachedResult.data.pagination) {
        totalResults.set(cachedResult.data.pagination.totalResults || 0);
        totalPages.set(cachedResult.data.pagination.totalPages || 1);
        currentPage.set(cachedResult.data.pagination.currentPage || 1);
      }
      
      contentTypeSwitching.set(false);
      return {
        ...cachedResult.data,
        hits: cachedMods,
        mods: cachedMods
      };
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
    // Read filters from the centralized stores
    const query = get(searchKeyword);
    const source = get(modSource);
    const filterVer = effectiveFilterMinecraftVersion;
    const loader = effectiveFilterModLoader || get(loaderType);
    const page = get(currentPage);
    const limit = get(resultsPerPage);
    const sortBy = options.sortBy || 'relevance';
    const environmentType = options.environmentType || 'all';
    
    // Use filter version if available and different from empty string
    // Empty string means "All Versions" (no filter) for all content types
    let versionToUse;
    if (filterVer && filterVer !== '') {
      // User selected a specific version
      versionToUse = filterVer;
    } else {
      // Empty string means "All Versions" (no version filter)
      versionToUse = undefined;
    }
    
    const invokeArgs = {
      keyword: query,
      source,
      // Only include loader for mods, not for shaders/resource packs
      loader: contentType === 'mods' ? loader : undefined,
      version: versionToUse,
      page,
      limit,
      sortBy,
      environmentType
    };

    
    
    // Use different IPC methods based on content type
    let ipcMethod;
    switch (contentType) {
      case 'shaders':
        ipcMethod = 'search-shaders';
        break;
      case 'resourcepacks':
        ipcMethod = 'search-resourcepacks';
        break;
      case 'mods':
      default:
        ipcMethod = 'search-mods';
        break;
    }
    
    const result = await safeInvoke(ipcMethod, invokeArgs);
    
    if (currentSearchId !== searchId) {
      return null;
    }
    
    if (result && result.mods) {
      const mods = result.mods.map((mod) => ({
        ...mod,
        isInstalled: matchesInstalledContent(mod, {
          installedIds,
          installedInfoList,
          installedFilesList
        })
      }));
      
      resultsStore.set(mods);
      
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

      const resultData = {
        hits: mods,
        totalHits: result.pagination?.totalResults || mods.length,
        totalPages: result.pagination?.totalPages || 1,
        mods: mods,
        pagination: result.pagination || {
          totalResults: mods.length,
          totalPages: 1,
          currentPage: page
        }
      };

      // Cache the successful result
      const cache = get(contentTypeCache);
      cache.set(cacheKey, {
        data: resultData,
        timestamp: Date.now()
      });
      contentTypeCache.set(cache);

      // Reset retry count on success
      const retryCount = get(contentTypeRetryCount);
      retryCount.delete(contentType);
      contentTypeRetryCount.set(retryCount);

      return resultData;
    } else {
      resultsStore.set([]);
      
      totalResults.set(0);
      totalPages.set(1);
      currentPage.set(1);
      if (result && result.error) {
        searchError.set(result.error);
      }
      return { hits: [], totalHits: 0, totalPages: 1 };
    }
  } catch (err) {
    // Implement retry mechanism
    const retryCount = get(contentTypeRetryCount);
    const currentRetries = retryCount.get(contentType) || 0;
    const maxRetries = 2;

    if (currentRetries < maxRetries) {
      // Increment retry count
      retryCount.set(contentType, currentRetries + 1);
      contentTypeRetryCount.set(retryCount);

      // Wait before retry with exponential backoff
      const retryDelay = Math.min(1000 * Math.pow(2, currentRetries), 5000);
      await new Promise(resolve => setTimeout(resolve, retryDelay));

      // Clear switching state temporarily for retry
      contentTypeSwitching.set(false);
      
      // Retry the search
      return await searchContent(contentType, { ...options, __retrying: true });
    }

    // Max retries reached, handle error
    searchError.set(`Search failed after ${maxRetries} retries: ${err.message || 'Unknown error'}`);
    
    getInstalledStateContext(contentType).resultsStore.set([]);
    
    return { hits: [], totalHits: 0, totalPages: 1, error: err.message };
  } finally {
    isSearching.set(false);
    contentTypeSwitching.set(false);

    if (pendingSearchRequest) {
      const queuedSearch = pendingSearchRequest;
      pendingSearchRequest = null;
      void searchContent(queuedSearch.contentType, queuedSearch.options);
    }
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
  // Use the new searchContent function with 'mods' as the content type
  return await searchContent('mods', options);
}

/**
 * Fetch versions for a mod
 * @param {string} modId - Mod ID
 * @param {string} source - Source ('modrinth' or 'curseforge')
 * @param {boolean} loadLatestOnly - Whether to only load the latest version
 * @param {boolean} forceRefresh - Whether to bypass cache and fetch fresh data
 * @returns {Promise<Array>} - Array of version objects
*/
export async function fetchModVersions(modId, source = 'modrinth', loadLatestOnly = false, forceRefresh = false, contentType = 'mods', updateContext = null) {
  // Cache key - NOTE: forceRefresh should NOT be part of the cache key
  const hasExplicitContext = !!updateContext;
  const loader = hasExplicitContext
    ? normalizeConfigValue(updateContext?.loader)
    : get(loaderType);
  const filterVer = hasExplicitContext || updateContext?.useFilter === false
    ? undefined
    : get(filterMinecraftVersion);
  const currentVersion = hasExplicitContext
    ? normalizeConfigValue(updateContext?.minecraftVersion)
    : get(minecraftVersion);
  
  // Use filter version if set, otherwise use current version
  // Empty string means "All Versions" - use undefined to not filter
  let gameVersion;
  if (Object.prototype.hasOwnProperty.call(updateContext || {}, 'gameVersion')) {
    gameVersion = normalizeConfigValue(updateContext?.gameVersion) || undefined;
  } else if (filterVer === '') {
    gameVersion = undefined; // All versions
  } else if (filterVer) {
    gameVersion = filterVer; // Specific filter version
  } else {
    gameVersion = currentVersion; // Current version as fallback
  }
  
  const cacheKey = `${modId}:${loader || 'vanilla'}:${gameVersion || 'all'}:${loadLatestOnly}`;

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
      loader: (contentType === 'shaders' || contentType === 'resourcepacks') ? null : loader,
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
 * Install content (mod, shader, or resource pack) from a source with fallback support
 * @param {Object} mod - Content object with source, id, title
 * @param {string} serverPath - Server path
 * @param {Object} [options] - Installation options
 * @param {boolean} [options.useFallback] - Whether to use fallback strategy (default: true)
 * @param {number} [options.maxRetries] - Maximum retry attempts (default: 3)
 * @param {number} [options.fallbackDelay] - Fallback delay in ms (default: 15 minutes)
 * @param {string} [options.contentType] - Content type ('mods', 'shaders', 'resourcepacks')
 * @returns {Promise<boolean>} Success status
 */

/**
 * Refresh search results to update installed status after installation
 * @param {string} contentType - Content type that was installed
 */
async function refreshSearchResults(contentType) {
  try {
    const {
      resultsStore,
      installedIds,
      installedInfoList,
      installedFilesList
    } = getInstalledStateContext(contentType);
    const currentResults = get(resultsStore);
    
    // Update the isInstalled status for all results
    const updatedResults = currentResults.map((item) => ({
      ...item,
      isInstalled: matchesInstalledContent(item, {
        installedIds,
        installedInfoList,
        installedFilesList
      })
    }));
    
    // Update the store with refreshed results
    resultsStore.set(updatedResults);
  } catch {
    // Failed to refresh search results
  }
}

export async function installMod(mod, serverPath, options = {}) {
  let trackedDownloadId = null;
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
    
    // Determine content type from options or mod data
    let contentType = options.contentType || mod.contentType || 'mods';

    // SAFEGUARD: If we have clear signals this is a mod (loader present OR jar download/file) but
    // the current contentType is shaders/resourcepacks (e.g. user was on another tab), coerce to 'mods'.
    const probableJar = (mod.downloadUrl && /\.jar($|\?)/i.test(mod.downloadUrl)) || (mod.fileName && /\.jar$/i.test(mod.fileName));
    if (contentType !== 'mods') {
      if (mod.loader || probableJar) {
        contentType = 'mods';
      }
    }

    // Additional heuristic: If title/name contains "fabric"/"forge" or common mod keywords, force mods
    const nameLc = (mod.name || mod.title || '').toLowerCase();
    if (contentType !== 'mods') {
      const modKeywords = ['fabric', 'forge', 'neoforge', 'quilt'];
      if (modKeywords.some(k => nameLc.includes(k))) {
        contentType = 'mods';
      }
    }
    

    
    // Get content type configuration
    const config = contentTypeConfigs[contentType] || contentTypeConfigs['mods'];
    
    // Prepare content data for installation with fallback support
    const contentData = {
      ...mod,
      // Make sure we set the loader and version if they're not already set
      loader: mod.loader || get(loaderType),
      version: mod.version || get(minecraftVersion),
      forceReinstall: isVersionUpdate, // Tell backend to replace existing version
      
      // Add content type information
      contentType: contentType,
      installDirectory: config.installDirectory,
      fileExtensions: config.fileExtensions,
      
      // Add fallback configuration
      useFallback: options.useFallback !== false, // Default to true
      maxRetries: options.maxRetries || 3,
      fallbackDelay: options.fallbackDelay || 15 * 60 * 1000, // 15 minutes
      
      // Add source information for fallback
      originalSource: mod.source || 'modrinth',
      projectId: mod.id, // Use mod.id as projectId for Modrinth
      modrinthId: mod.id,
      curseforgeId: mod.curseforgeId || null,
      
      // Add checksum information if available
      expectedChecksum: mod.checksum || null,
      checksumAlgorithm: mod.checksumAlgorithm || 'sha1'
    };

    trackedDownloadId = queueInstallDownload(mod, contentType, {
      downloadId: options.downloadId,
      source: mod.source || contentData.originalSource,
      maxAttempts: contentData.maxRetries,
      statusMessage: 'Queued for download...'
    });
    contentData.downloadId = trackedDownloadId;
    
    // Use appropriate install method based on content type
    let ipcMethod;
  switch (contentType) {
      case 'shaders':
        ipcMethod = 'install-shader-with-fallback';
        break;
      case 'resourcepacks':
        ipcMethod = 'install-resourcepack-with-fallback';
        break;
      case 'mods':
      default:
        ipcMethod = 'install-mod';
        break;
    }
    
    const result = await safeInvoke(ipcMethod, serverPath, contentData);
    
    // Handle result
    if (result && result.success) {
      // Success! - Removed duplicate success message since we have toast notifications
      // const sourceInfo = result.source && result.source !== 'server' ? 
      //                   ` (downloaded from ${result.source})` : '';
      // successMessage.set(`Successfully installed ${mod.title || mod.name}${sourceInfo}`);
      

      
      // Reload the appropriate content list based on content type
      if (contentType === 'shaders') {
        await loadContent(serverPath, 'shaders');
      } else if (contentType === 'resourcepacks') {
        await loadContent(serverPath, 'resourcepacks');
      } else {
        await loadMods(serverPath);
      }
      
      // Refresh search results to update installed status
      await refreshSearchResults(contentType);
      
      // Clear the success message after a delay
      setTimeout(() => {
        successMessage.set('');
      }, 3000);
      
      return true;
    } else {
      // Installation failed - provide detailed error information
      let errorMsg = result?.error || 'Unknown error during installation';
      
      // Add fallback information to error message if available
      if (result?.fallbackAttempted) {
        errorMsg += ` (fallback to ${result.fallbackSource} also failed)`;
      }
      
      if (result?.checksumErrors > 0) {
        errorMsg += ` (${result.checksumErrors} checksum validation failures)`;
      }
      
      throw new Error(errorMsg);
    }
  } catch (err) {
    // Enhanced error logging with fallback information
    if (trackedDownloadId) {
      completeDownload(trackedDownloadId, true, err.message || 'Installation failed');
    }
    errorMessage.set(`Failed to install mod: ${err.message}`);
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
 * Delete content from server (mod, shader, or resource pack)
 * @param {string} itemName - Name of the item to delete
 * @param {string} serverPath - Path to the server
 * @param {string} contentType - Type of content ('mods', 'shaders', 'resourcepacks')
 * @param {boolean} shouldReload - Whether to reload the content list after deletion
 * @returns {Promise<boolean>} - True if successful
 */
export async function deleteContent(itemName, serverPath, contentType = 'mods', shouldReload = true) {
  try {
    if (!itemName || !serverPath) {
      errorMessage.set(`Invalid ${contentType === 'mods' ? 'mod' : contentType === 'shaders' ? 'shader' : 'resource pack'} name or server path for deletion`);
      return false;
    }
    
    // Use appropriate IPC method based on content type
    let ipcMethod;
    switch (contentType) {
      case 'shaders':
        ipcMethod = 'delete-shader';
        break;
      case 'resourcepacks':
        ipcMethod = 'delete-resourcepack';
        break;
      case 'mods':
      default:
        ipcMethod = 'delete-mod';
        break;
    }
    
    const result = await safeInvoke(ipcMethod, serverPath, itemName);
    
    // Handle new response format with enhanced feedback
    if (result === true || (result && result.success)) {
      const itemType = contentType === 'mods' ? 'mod' : contentType === 'shaders' ? 'shader' : 'resource pack';
      let message = `Successfully deleted ${itemType} ${itemName}`;
      
      // Provide additional feedback based on the deletion result
      if (result && result.deletedFrom) {
        if (result.deletedFrom === 'not_found') {
          message = `${itemName} was not found (may have been already deleted)`;
        }
      }
      
      successMessage.set(message);
      setTimeout(() => successMessage.set(''), 3000);
      
      if (shouldReload) {
        await loadContent(serverPath, contentType);
      }
      
      return true;
    } else {
      const itemType = contentType === 'mods' ? 'mod' : contentType === 'shaders' ? 'shader' : 'resource pack';
      errorMessage.set(`Failed to delete ${itemType}: ${result?.error || 'Unknown error'}`);
      return false;
    }
  } catch (error) {
    const itemType = contentType === 'mods' ? 'mod' : contentType === 'shaders' ? 'shader' : 'resource pack';
    errorMessage.set(`Error deleting ${itemType}: ${error.message || 'Unknown error'}`);
    return false;
  }
}

// Keep the original deleteMod function for backward compatibility
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
  } catch (error) {
    errorMessage.set(`Failed to delete ${modName}: ${error.message || 'Unknown error'}`);
    return false;
  }
}

/**
 * Check for updates for installed mods
 * @param {string} serverPath - Server path
 * @param {boolean} forceRefresh - Whether to bypass cache and fetch fresh data
 * @returns {Promise<Map<string, Object>>} - Map of mod names to update info
 */
export async function checkForUpdates(serverPath, forceRefresh = false, options = {}) {
  const normalizedPath = normalizePathForUpdates(serverPath);
  const requestedContentTypes = normalizeRequestedContentTypes(options.contentTypes);
  const includeMods = !requestedContentTypes || requestedContentTypes.includes('mods');
  const includeShaders = !requestedContentTypes || requestedContentTypes.includes('shaders');
  const includeResourcePacks = !requestedContentTypes || requestedContentTypes.includes('resourcepacks');

  // Prevent concurrent update checks
  if (get(isCheckingUpdates)) {
    // Queue a follow-up check to run right after the current one finishes
    // If multiple calls arrive, prefer the more aggressive (forceRefresh) option
    pendingUpdateCheck = {
      serverPath: serverPath || (pendingUpdateCheck?.serverPath || null),
      forceRefresh: forceRefresh || (pendingUpdateCheck?.forceRefresh || false),
      options: mergeUpdateCheckOptions(pendingUpdateCheck?.options, options)
    };
    if (normalizedPath && activeUpdateServerPath && normalizedPath !== activeUpdateServerPath) {
      updateCheckId += 1;
    }
    return new Map();
  }

  // Clear stale update indicators while a fresh check runs, but keep a snapshot to restore on failure
  const previousUpdatesSnapshot = (() => {
    try {
      const existing = get(modsWithUpdates);
      return existing ? new Map(existing) : null;
    } catch {
      return null;
    }
  })();
  const pathChanged = normalizedPath && lastUpdateCheckPath && normalizedPath !== lastUpdateCheckPath;
  let clearedUpdatesForCheck = false;
  if (pathChanged) {
    modsWithUpdates.set(new Map());
    disabledModUpdates.set(new Map());
    clearedUpdatesForCheck = true;
  }
  if (normalizedPath) {
    lastUpdateCheckPath = normalizedPath;
  }

  isCheckingUpdates.set(true);
  activeUpdateServerPath = normalizedPath;
  const currentCheckId = ++updateCheckId;

  const updatesMap = new Map();
  const isStaleCheck = () => currentCheckId !== updateCheckId || !isCurrentModServerPath(serverPath);
  let processedChecks = 0;
  let totalCheckCount = 0;

  const setUpdateCheckProgress = (phase = '') => {
    updateCheckProgress.set({
      active: totalCheckCount > 0,
      current: Math.min(processedChecks, totalCheckCount),
      total: totalCheckCount,
      phase
    });
  };

  try {
    if (!serverPath || !isCurrentModServerPath(serverPath)) {
      if (clearedUpdatesForCheck && previousUpdatesSnapshot && !pathChanged) {
        modsWithUpdates.set(previousUpdatesSnapshot);
      }
      return updatesMap;
    }

    // If forcing refresh, clear ALL version caches to ensure fresh data
    if (forceRefresh) {
      modVersionsCache.set({});
      installedModVersionsCache.set({});
    }

    const config = await loadServerConfig(serverPath, { syncStores: false });
    const updateContext = createUpdateContext(serverPath, config);

    if (!updateContext.minecraftVersion) {
      if (!isStaleCheck()) {
        modsWithUpdates.set(new Map());
        disabledModUpdates.set(new Map());
      }
      return updatesMap;
    }

    if (isStaleCheck()) {
      return updatesMap;
    }
    
    // Get all content with project IDs (mods, shaders, resource packs)
    const modsInfo = get(installedModInfo);
    const shadersInfo = get(installedShaderInfo);
    const resourcePacksInfo = get(installedResourcePackInfo);
    const disabledModsSet = get(disabledMods);
    
    const modsWithProjectIds = includeMods
      ? modsInfo.filter(m => m.projectId && !disabledModsSet.has(m.fileName))
      : [];
    const disabledModsWithProjectIds = includeMods
      ? modsInfo.filter(m => m.projectId && disabledModsSet.has(m.fileName))
      : [];
    const shadersWithProjectIds = includeShaders
      ? shadersInfo.filter(s => s.projectId)
      : [];
    const resourcePacksWithProjectIds = includeResourcePacks
      ? resourcePacksInfo.filter(r => r.projectId)
      : [];
    
    const allContentWithProjectIds = [
      ...modsWithProjectIds.map(m => ({ ...m, contentType: 'mods' })),
      ...shadersWithProjectIds.map(s => ({ ...s, contentType: 'shaders' })),
      ...resourcePacksWithProjectIds.map(r => ({ ...r, contentType: 'resourcepacks' }))
    ];

    totalCheckCount = allContentWithProjectIds.length + disabledModsWithProjectIds.length;
    if (totalCheckCount > 0) {
      setUpdateCheckProgress(
        allContentWithProjectIds.length > 0 ? 'Checking installed content' : 'Checking disabled mods'
      );
    }
    
    if (allContentWithProjectIds.length === 0) {
      if (!isStaleCheck()) {
        modsWithUpdates.set(new Map());
        if (includeMods && disabledModsWithProjectIds.length > 0) {
          setUpdateCheckProgress('Checking disabled mods');
        }
        if (includeMods) {
          await checkDisabledModUpdates(serverPath, updateContext);
        }
        if (!isStaleCheck() && totalCheckCount > 0) {
          processedChecks = totalCheckCount;
          setUpdateCheckProgress('Completed');
        }
        try { lastUpdateCheckTime.set(Date.now()); } catch { /* ignore timestamp errors */ }
      }
      return updatesMap;
    }
    
    for (const contentInfo of allContentWithProjectIds) {
      // Check if a newer update check has started
      if (isStaleCheck()) {
        break;
      }

      try {
        if (
          contentInfo.contentType === 'mods' &&
          !isInstalledBuildCompatibleWithContext(contentInfo, updateContext)
        ) {
          logger.info('Skipping version lookup for incompatible installed mod build', {
            category: 'mods',
            data: {
              component: 'modAPI',
              function: 'checkForUpdates',
              modFile: contentInfo.fileName,
              modName: contentInfo.name || null,
              installedVersion: contentInfo.versionNumber || contentInfo.version || null,
              minecraftVersion: updateContext.minecraftVersion || updateContext.gameVersion || null,
              installedGameVersions: getInstalledGameVersionHints(contentInfo),
              forceLog: true
            }
          });
          continue;
        }

        if (!contentInfo.projectId) {
          continue;
        }

        try {
          // Always fetch fresh versions to check for updates
          // This ensures we detect if a user has installed an older version
          const versions = await fetchModVersions(
            contentInfo.projectId,
            'modrinth',
            false,
            forceRefresh,
            contentInfo.contentType,
            updateContext
          );

          if (isStaleCheck()) {
            break;
          }
          
          // Update cache using the active instance/version context.
          setInstalledVersionCacheEntry(
            contentInfo.projectId,
            versions,
            contentInfo.contentType,
            updateContext
          );
          
          // Check if an update is available
          const updateVersion = checkForUpdate(contentInfo, versions, updateContext);
          if (updateVersion) {
            // Skip if this version is ignored for this file
            try {
              const candidates = [
                updateVersion.versionNumber,
                updateVersion.version_number,
                updateVersion.name
              ].filter(Boolean);
              let ignored = false;
              for (const c of candidates) {
                if (isUpdateIgnored(contentInfo.fileName, updateVersion.id, c)) { ignored = true; break; }
                const norm = String(c).trim().toLowerCase().replace(/^v/, '');
                if (norm !== c && isUpdateIgnored(contentInfo.fileName, updateVersion.id, norm)) { ignored = true; break; }
              }
              if (ignored) continue;
            } catch { /* ignore filtering errors */ }
            // Only add the filename to the updates map for display
            // This ensures we don't double-count updates
            updatesMap.set(contentInfo.fileName, updateVersion);
            
            // Store the project ID separately for reference in the Find tab
            // We'll use a special prefix to distinguish it from actual filenames
            updatesMap.set(`project:${contentInfo.projectId}`, updateVersion);
          }
        } catch {
          // Silently skip this content
        }
      } finally {
        processedChecks += 1;
        if (!isStaleCheck() && totalCheckCount > 0) {
          setUpdateCheckProgress('Checking installed content');
        }
      }
    }

    if (isStaleCheck()) {
      return updatesMap;
    }
    
    // Update the store
    modsWithUpdates.set(updatesMap);
    if (includeMods && totalCheckCount > 0) {
      setUpdateCheckProgress('Checking disabled mods');
    }
    if (includeMods) {
      await checkDisabledModUpdates(serverPath, updateContext);
    }
    if (!isStaleCheck() && totalCheckCount > 0) {
      processedChecks = totalCheckCount;
      setUpdateCheckProgress('Completed');
    }
    try { lastUpdateCheckTime.set(Date.now()); } catch { /* ignore timestamp errors */ }
    return updatesMap;
  } catch {
    if (!isStaleCheck() && clearedUpdatesForCheck && previousUpdatesSnapshot && !pathChanged) {
      modsWithUpdates.set(previousUpdatesSnapshot);
    }
    return updatesMap;
  } finally {
    activeUpdateServerPath = '';
    isCheckingUpdates.set(false);
    updateCheckProgress.set({ active: false, current: 0, total: 0, phase: '' });
    // If a check was requested while we were busy, run it now
    if (pendingUpdateCheck) {
      const {
        serverPath: pendingPath,
        forceRefresh: pendingForce,
        options: pendingOptions
      } = pendingUpdateCheck;
      pendingUpdateCheck = null;
      // Fire-and-forget to avoid recursive blocking; errors are handled internally
      // Use setTimeout to yield back to the event loop
      setTimeout(() => {
        checkForUpdates(pendingPath || serverPath, pendingForce, pendingOptions);
      }, 0);
    }
  }
}

/**
 * Check for updates available for disabled mods
 * @param {string} serverPath - Server path
 */
export async function checkDisabledModUpdates(serverPath, updateContext = null) {
  try {
    if (!serverPath) {
      disabledModUpdates.set(new Map());
      return;
    }

    if (!isCurrentModServerPath(serverPath)) {
      return;
    }

    const strictContext = updateContext || createUpdateContext(
      serverPath,
      await loadServerConfig(serverPath, { syncStores: false })
    );
    const mcVersion = normalizeConfigValue(strictContext?.minecraftVersion || strictContext?.gameVersion);
    
    if (!mcVersion) {
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

    if (!isCurrentModServerPath(serverPath)) {
      return;
    }
    
    // Filter for mods that have compatible updates available
    const disabledUpdatesMap = new Map();
    
    for (const result of results) {
      if (result.isCompatibleUpdate && result.hasUpdate) {
        const rawFileName = result.fileName || '';
        const normalizedName = rawFileName.split(/[\\/]/).pop() || rawFileName;
        // Skip if user has ignored this update/version
        const ignored = isUpdateIgnored(normalizedName, result.latestVersionId, result.latestVersion);
        if (ignored) continue;
        disabledUpdatesMap.set(normalizedName, {
          projectId: result.projectId,
          currentVersion: result.currentVersion,
          latestVersion: result.latestVersion,
          latestVersionId: result.latestVersionId,
          reason: result.reason,
          name: result.name,
          fileName: normalizedName,
          originalFileName: rawFileName
        });
      }
    }
    disabledModUpdates.set(disabledUpdatesMap);
    
  } catch {
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
 * @param {boolean} skipReload - Skip reloading mod list (useful for batch updates)
 * @returns {Promise<boolean>} - Success status
 */
export async function enableAndUpdateMod(serverPath, modFileName, projectId, targetVersion, targetVersionId, skipReload = false) {
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
        mods.delete(modFileName);
        return mods;
      });

      // Only reload if not in batch mode
      if (!skipReload) {
        // Force reload the mod list to get the latest information
        await loadMods(serverPath);

        successMessage.set(`${modFileName} successfully enabled and updated to ${targetVersion}`);
        setTimeout(() => successMessage.set(''), 3000);
      }

      return true;
    } else {
      if (!skipReload) {
        errorMessage.set(`Failed to enable and update mod: ${result.error}`);
        setTimeout(() => errorMessage.set(''), 5000);
      }
      return false;
    }

  } catch (err) {
    if (!skipReload) {
      errorMessage.set(`Error enabling and updating mod: ${err.message}`);
      setTimeout(() => errorMessage.set(''), 5000);
    }
    return false;
  }
}

/**
 * Check if a mod has an update available
 * @param {Object} modInfo - Installed mod info
 * @param {Array} versions - Available versions
 * @returns {Object|null} - The update version or null
 */
function checkForUpdate(modInfo, versions, updateContext = null) {
  const installedVersionRaw = modInfo?.versionNumber || modInfo?.version || '';
  if (!versions || versions.length === 0 || !modInfo || !installedVersionRaw) {
    return null;
  }
  // Loose numeric comparator: returns <0 if a<b, 0 if equal, >0 if a>b
  const compareLoose = (a, b) => {
    try {
      const norm = (v) => String(v || '').trim().toLowerCase().replace(/^v/, '');
      const extractNumbers = (v) => {
        const matches = norm(v).match(/\d+/g);
        return matches ? matches.map(n => parseInt(n, 10)).filter(n => !Number.isNaN(n)) : [];
      };
      const as = extractNumbers(a);
      const bs = extractNumbers(b);
      if (!as.length || !bs.length) return 0;
      const len = Math.max(as.length, bs.length);
      for (let i = 0; i < len; i++) {
        const ai = as[i] || 0; const bi = bs[i] || 0;
        if (ai !== bi) return ai - bi;
      }
      return 0;
    } catch { return 0; }
  };
  
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

  // Determine Minecraft-version compatible versions
  let latestVersion = null;
  const currentMc = updateContext?.minecraftVersion || updateContext?.gameVersion || get(minecraftVersion);
  const installedId = modInfo.versionId;
  const installedEntry = versions.find(v =>
    (installedId && v.id === installedId) ||
    v.versionNumber === installedVersionRaw ||
    v.version_number === installedVersionRaw
  );
  const installedGameVersions = getInstalledGameVersionHints(modInfo, installedEntry);
  try {
    if (!currentMc) {
      logger.info('Skipping update check without minecraftVersion context', {
        category: 'mods',
        data: {
          component: 'modAPI',
          function: 'checkForUpdate',
          modFile: modInfo.fileName,
          modName: modInfo.name || null,
          forceLog: true
        }
      });
      return null;
    }
    if (currentMc) {
      if (
        installedGameVersions.length > 0 &&
        !installedGameVersions.some(gv => isGameVersionCompatible(currentMc, gv))
      ) {
        logger.info('Skipping update check for incompatible installed mod build', {
          category: 'mods',
          data: {
            component: 'modAPI',
            function: 'checkForUpdate',
            modFile: modInfo.fileName,
            modName: modInfo.name || null,
            installedVersion: installedVersionRaw,
            installedGameVersions,
            minecraftVersion: currentMc,
            installedId: installedId || null,
            forceLog: true
          }
        });
        return null;
      }

      const compatible = sortedVersions.filter(v => {
        if (!v || !Array.isArray(v.gameVersions)) return false;
        return v.gameVersions.some(gv => isGameVersionCompatible(currentMc, gv));
      });
      if (compatible.length > 0) {
        latestVersion = compatible[0];
      } else {
        // No compatible versions -> treat as NO update even if newer future versions exist
        logger.info('No compatible mod versions for current Minecraft', {
          category: 'mods',
          data: {
            component: 'modAPI',
            function: 'checkForUpdate',
            modFile: modInfo.fileName,
            modName: modInfo.name || null,
            installedVersion: installedVersionRaw,
            minecraftVersion: currentMc,
            candidateCount: versionsToCheck.length,
            sampleCandidates: versionsToCheck.slice(0, 3).map(v => ({
              version: v.versionNumber || v.name || null,
              gameVersions: v.gameVersions || []
            })),
            forceLog: true
          }
        });
        return null;
      }
    }
  } catch { /* ignore filter errors */ }
  // If no minecraft version context (unlikely), fall back to newest stable
  if (!latestVersion) {
    latestVersion = sortedVersions[0];
  }
  
  // Offer update only if the latest compatible version is strictly newer than installed.
  if (latestVersion) {
    const norm = (v) => (typeof v === 'string' ? v.trim().replace(/^v/i, '') : v);
    const installedVer = norm(installedVersionRaw);
    const latestVer = norm(latestVersion.versionNumber || latestVersion.name || '');
    const cmp = compareLoose(installedVer, latestVer);
    if (cmp < 0) {
      logger.info('Update available (newer version number)', {
        category: 'mods',
        data: {
          component: 'modAPI',
          function: 'checkForUpdate',
          modFile: modInfo.fileName,
          modName: modInfo.name || null,
          installedVersion: installedVersionRaw,
          candidateVersion: latestVersion.versionNumber || latestVersion.name,
          minecraftVersion: currentMc,
          candidateGameVersions: latestVersion.gameVersions || [],
          candidateId: latestVersion.id || null,
          forceLog: true
        }
      });
      return latestVersion; // only if strictly newer numerically
    }

    const installedId = modInfo.versionId;
    const latestId = latestVersion.id;
    const idsDiffer = installedId && latestId && installedId !== latestId;

    // If numeric parts are equal, only treat as update when there's a meaningful difference:
    // - raw strings differ (e.g., different build tag), OR
    // - IDs differ AND published date of the candidate is newer than the installed entry (when known)
    if (cmp === 0) {
      const rawStringsDiffer = installedVer && latestVer && installedVer !== latestVer;
      if (rawStringsDiffer) {
        logger.info('Update available (string mismatch with equal numeric parts)', {
          category: 'mods',
          data: {
            component: 'modAPI',
            function: 'checkForUpdate',
            modFile: modInfo.fileName,
            modName: modInfo.name || null,
            installedVersion: installedVersionRaw,
            candidateVersion: latestVersion.versionNumber || latestVersion.name,
            minecraftVersion: currentMc,
            candidateGameVersions: latestVersion.gameVersions || [],
            candidateId: latestVersion.id || null,
            installedId: installedId || null,
            forceLog: true
          }
        });
        return latestVersion;
      }

      if (idsDiffer) {
        // Try to locate the installed entry to compare dates
        const installedDate = installedEntry?.datePublished ? new Date(installedEntry.datePublished).getTime() : null;
        const latestDate = latestVersion.datePublished ? new Date(latestVersion.datePublished).getTime() : null;

        if (installedDate && latestDate && latestDate > installedDate) {
          logger.info('Update available (newer publish date with same numeric)', {
            category: 'mods',
            data: {
              component: 'modAPI',
              function: 'checkForUpdate',
              modFile: modInfo.fileName,
              modName: modInfo.name || null,
              installedVersion: installedVersionRaw,
              candidateVersion: latestVersion.versionNumber || latestVersion.name,
              minecraftVersion: currentMc,
              candidateGameVersions: latestVersion.gameVersions || [],
              candidateId: latestVersion.id || null,
              installedId: installedId || null,
              forceLog: true
            }
          });
          return latestVersion; // newer build with same number
        }
      }
    }

    // No update needed: current version is latest or equivalent for this MC version
    logger.info('No update needed (already latest/compatible for MC)', {
      category: 'mods',
      data: {
        component: 'modAPI',
        function: 'checkForUpdate',
        modFile: modInfo.fileName,
        modName: modInfo.name || null,
        installedVersion: installedVersionRaw,
        candidateVersion: latestVersion ? (latestVersion.versionNumber || latestVersion.name) : null,
        minecraftVersion: currentMc,
        candidateGameVersions: latestVersion ? (latestVersion.gameVersions || []) : [],
        installedId: modInfo.versionId || null,
        candidateId: latestVersion ? latestVersion.id || null : null,
        forceLog: true
      }
    });
  }
  
  return null;
}
