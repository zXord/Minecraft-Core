// Mod API service functions
const fetch = require('node-fetch');

// Modrinth API base URL
const MODRINTH_API = 'https://api.modrinth.com/v2';

// Add a rate limiter utility
const RATE_LIMIT_MS = 500; // Delay between API requests
let lastRequestTime = 0;

/**
 * Simple rate limiter that ensures a minimum delay between API requests
 * @returns {Promise<void>} Resolves when it's safe to make another request
 */
async function rateLimit() {
  const now = Date.now();
  const elapsed = now - lastRequestTime;
  
  if (elapsed < RATE_LIMIT_MS && lastRequestTime > 0) {
    const delay = RATE_LIMIT_MS - elapsed;
    await new Promise(resolve => setTimeout(resolve, delay));
  }
  
  lastRequestTime = Date.now();
}

// Version cache to reduce API calls
const versionCache = new Map();

/**
 * Clear the version cache - useful when checking compatibility for different versions
 */
function clearVersionCache() {
  versionCache.clear();
}

/**
 * Helper function to convert our sort options to Modrinth API format
 * @param {string} sortBy - Sort option
 * @returns {string} - Converted sort option
 */
function convertSortToModrinthFormat(sortBy) {
  
  // Convert our sort values to Modrinth's expected format
  let modrinthSort;
  switch (sortBy) {
    case 'relevance': 
      modrinthSort = 'relevance';
      break;
    case 'downloads': 
      modrinthSort = 'downloads';
      break;
    case 'follows': 
      modrinthSort = 'follows';
      break;
    case 'newest': 
      modrinthSort = 'newest';
      break;
    case 'updated': 
      modrinthSort = 'updated';
      break;
    default: 
      modrinthSort = 'relevance';
  }
  
  return modrinthSort;
}

/**
 * Get popular mods from Modrinth
 * 
 * @param {Object} options - Search options
 * @param {string} options.loader - Mod loader (fabric, forge, etc.)
 * @param {string} options.version - Minecraft version
 * @param {number} options.page - Page number (1-based)
 * @param {number} options.limit - Results per page
 * @param {string} options.sortBy - Sort method (popular, recent, downloads, name)
 * @returns {Promise<Object>} Object with mods array and pagination info
 */
async function getModrinthPopular({ loader, version, page = 1, limit = 20, sortBy = 'relevance' }) {
  await rateLimit();
  
  
  const modrinthSortBy = convertSortToModrinthFormat(sortBy);
  
  // Build the facets array
  const facets = [];
  if (loader) {
    facets.push([`categories:${loader}`]);
  }
  if (version) {
    facets.push(["versions:" + version]);
  }
  

  
  // Convert facets to JSON string
  const facetsParam = JSON.stringify(facets);
  
  // Build request URL
  const url = new URL(`${MODRINTH_API}/search`);
  url.searchParams.append('offset', ((page - 1) * limit).toString());
  url.searchParams.append('limit', limit.toString());
  url.searchParams.append('facets', facetsParam);
  
  // Add sorting parameter in multiple formats to ensure compatibility
  url.searchParams.append('index', modrinthSortBy);  // For newer API versions
  
  // Execute request
  
  const response = await fetch(url.toString(), {
    headers: {
      'User-Agent': 'minecraft-core/1.0.0'
    }
  });

  if (!response.ok) {
    throw new Error(`Modrinth API error: ${response.status}`);
  }

  const data = await response.json();

  const mods = data.hits.map(mod => ({
      id: mod.project_id,
      slug: mod.slug,
      name: mod.title,
      description: mod.description,
      author: mod.author,
      downloads: mod.downloads,
      followers: mod.follows || 0, // Add followers field
      versions: formatModVersions(mod.versions),
      iconUrl: mod.icon_url || null,
      source: 'modrinth',
      downloadUrl: mod.project_id,
      clientSide: mod.client_side === 'required' || mod.client_side === 'optional',
      serverSide: mod.server_side === 'required' || mod.server_side === 'optional'
    }));
    
  return {
    mods,
    pagination: {
      currentPage: page,
      totalResults: data.total_hits,
      totalPages: Math.ceil(data.total_hits / limit),
      limit
    }
  };
}

/**
 * Search for mods on Modrinth
 * 
 * @param {Object} options - Search options
 * @param {string} options.query - Search query
 * @param {string} options.loader - Mod loader (fabric, forge, etc.)
 * @param {string} options.version - Minecraft version
 * @param {number} options.page - Page number (1-based)
 * @param {number} options.limit - Number of results per page
 * @param {string} [options.sortBy='relevance'] - Sort by option
 * @returns {Promise<Object>} Object with mods array and pagination info
 */
async function searchModrinthMods({ query, loader, version, page = 1, limit = 20, sortBy = 'relevance' }) {
  
  await rateLimit();
  
  
  const modrinthSortBy = convertSortToModrinthFormat(sortBy);
  
  // Build the facets array
  const facets = [];
  if (loader) {
    facets.push([`categories:${loader}`]);
  }
  if (version) {
    facets.push(["versions:" + version]);
  }
  

  
  // Convert facets to JSON string
  const facetsParam = JSON.stringify(facets);
  
  // Build request URL
  const url = new URL(`${MODRINTH_API}/search`);
  url.searchParams.append('query', query);
  url.searchParams.append('offset', ((page - 1) * limit).toString());
  url.searchParams.append('limit', limit.toString());
  url.searchParams.append('facets', facetsParam);
  
  // Add sorting parameter in multiple formats to ensure compatibility
  url.searchParams.append('index', modrinthSortBy);  // For newer API versions
  
  // Execute request
  
  const response = await fetch(url.toString(), {
    headers: {
      'User-Agent': 'minecraft-core/1.0.0'
    }
  });

  if (!response.ok) {
    throw new Error(`Modrinth API error (${response.status}): ${response.statusText}`);
  }

  const data = await response.json();

  const mods = data.hits.map(project => ({
      id: project.project_id,
      slug: project.slug,
      name: project.title,
      description: project.description,
      thumbnail: project.icon_url,
      iconUrl: project.icon_url || null,
      downloads: project.downloads,
      followers: project.follows,
      categories: project.categories || [],
      author: project.author,
      clientSide: project.client_side === 'required' || project.client_side === 'optional',
      serverSide: project.server_side === 'required' || project.server_side === 'optional',
      lastUpdated: project.date_modified,
      source: 'modrinth'
    }));

  return {
    mods,
    pagination: {
      totalResults: data.total_hits,
      totalPages: Math.ceil(data.total_hits / limit),
      currentPage: page
    }
  };
}

/**
 * Format version strings to make them more concise and readable
 * Show only full releases, not snapshots/alphas/betas
 * 
 * @param {string[]} versions - Array of version strings
 * @returns {string[]} Formatted array of version strings
 */
function formatModVersions(versions) {
  if (!versions || !Array.isArray(versions) || versions.length === 0) {
    return ['Unknown'];
  }
  
  // Strict filtering for release versions only
  const releaseVersions = versions.filter(v => {
    if (!v || typeof v !== 'string') return false;
    
    // Convert to lowercase for case-insensitive comparison
    const lowerV = v.toLowerCase();
    
    // Check for snapshot pattern like "25w02a" (week-based snapshots)
    // Format is usually [YY]w[WW][a-z]
    if (/\d+w\d+[a-z]?/.test(v)) {
      return false;
    }
    
    // Skip any version with these keywords
    const nonReleaseKeywords = [
      'alpha', 'beta', 'snapshot', 'pre', 'rc', 'experimental', 
      'dev', 'test', 'nightly', 'preview'
    ];
    
    // Check if version has any of the non-release keywords
    if (nonReleaseKeywords.some(keyword => lowerV.includes(keyword))) {
      return false;
    }
    
    // Check for Minecraft's older pre-release pattern like "1.16-pre1" or "1.17-rc1"
    if (/-pre\d+/.test(v) || /-rc\d+/.test(v)) {
      return false;
    }
    
    return true;
  });
  
  // If there are no release versions at all, return a meaningful message
  if (releaseVersions.length === 0) {
    return ['No stable releases'];
  }
  
  // Sort versions by semantic versioning (e.g., 1.20.1, 1.19.4, 1.19.2, etc.)
  const sortedVersions = [...releaseVersions].sort((a, b) => {
    // Try to extract semantic version parts (1.19.2 -> [1, 19, 2])
    const aParts = a.split('.').map(part => parseInt(part) || 0);
    const bParts = b.split('.').map(part => parseInt(part) || 0);
    
    for (let i = 0; i < Math.max(aParts.length, bParts.length); i++) {
      const aVal = aParts[i] || 0;
      const bVal = bParts[i] || 0;
      if (aVal !== bVal) {
        return bVal - aVal; // Descending order
      }
    }
    return 0;
  });
  
  // If there are more than 3 versions, only show the 3 most recent ones
  if (sortedVersions.length > 3) {
    // Return the 3 latest versions and indicate more are available
    return sortedVersions.slice(0, 3).concat([`+${releaseVersions.length - 3} more`]);
  }
  
  return sortedVersions;
}

/**
 * Get download URL for a Modrinth mod
 * 
 * @param {string} projectId - Modrinth project ID
 * @param {string} version - Minecraft version
 * @param {string} loader - Mod loader (fabric, forge, etc.)
 * @returns {Promise<string>} Download URL
 */
async function getModrinthDownloadUrl(projectId, version, loader) {
  const versions = await getModrinthVersions(projectId, loader, version);

  if (versions.length === 0) {
    throw new Error('No matching versions found for this mod');
  }

  const latest = versions[0];
  const versionInfo = await getModrinthVersionInfo(projectId, latest.id, version, loader);

  if (!versionInfo.files || versionInfo.files.length === 0) {
    throw new Error('No files found for this mod version');
  }

  const primaryFile = versionInfo.files.find(file => file.primary) || versionInfo.files[0];
  return primaryFile.url;
}

/**
 * Get information about a Modrinth mod project
 * 
 * @param {string} projectId - Modrinth project ID
 * @returns {Promise<Object>} Project info
 */
async function getModrinthProjectInfo(projectId) {
  await rateLimit();
  const response = await fetch(`${MODRINTH_API}/project/${projectId}`);
  
  if (!response.ok) {
    // Add specific diagnostics for 404 errors
    if (response.status === 404) {
      console.warn(`🔍 Mod Project Diagnostic: Project ID "${projectId}" not found (404)`);
      console.warn(`   This could mean:`);
      console.warn(`   - The mod was removed from Modrinth`);
      console.warn(`   - The project ID is incorrect or outdated`);
      console.warn(`   - The mod might have been renamed or transferred`);
      console.warn(`   💡 User action: Try searching for this mod manually and re-installing it`);
      console.warn(`   🔗 Search URL: https://modrinth.com/mods?q=${encodeURIComponent(projectId)}`);
      
      // Return a user-friendly error message
      throw new Error(`Mod not found on Modrinth - the mod may have been removed or the project ID is outdated. Try re-installing this mod.`);
    }
    
    throw new Error(`Modrinth API error: ${response.status}`);
  }

  return await response.json();
}

/**
 * Get general mod information from a supported source
 *
 * @param {string} modId - Mod ID or project ID
 * @param {string} [source='modrinth'] - Mod source (currently only Modrinth)
 * @returns {Promise<Object>} Mod information object
 */
async function getModInfo(modId, source = 'modrinth') {
  if (source === 'modrinth') {
    return getModrinthProjectInfo(modId);
  }

  throw new Error('Only Modrinth mod info is currently supported');
}

/**
 * Resolve dependency information from Modrinth
 * 
 * @param {Array} dependencies - Array of dependency objects
 * @returns {Promise<Array>} Array of resolved dependency objects with names
 */
async function resolveModrinthDependencies(dependencies) {
  const resolvedDeps = [];
  
  for (const dep of dependencies) {
    if (dep.project_id && dep.dependency_type === 'required') {
      try {
        const projectInfo = await getModrinthProjectInfo(dep.project_id);

        resolvedDeps.push({
          projectId: dep.project_id,
          name: projectInfo.title,
          dependencyType: dep.dependency_type
        });
      } catch {
        resolvedDeps.push({
          projectId: dep.project_id,
          name: 'Unknown Mod',
          dependencyType: dep.dependency_type
        });
      }
    }
  }
  
  return resolvedDeps;
}

/**
 * Get versions for a Modrinth mod
 * 
 * @param {string} projectId - Modrinth project ID
 * @param {string} loader - Mod loader (fabric, forge, etc.)
 * @param {string} gameVersion - Minecraft version
 * @param {boolean} loadLatestOnly - Whether to only load the latest version
 * @returns {Promise<Array>} Array of version objects
 */
async function getModrinthVersions(projectId, loader, gameVersion, loadLatestOnly = false) {  // Check cache first
  const cacheKey = `${projectId}:${loader || ''}:${gameVersion || ''}`;
  if (versionCache.has(cacheKey)) {
    
    // If we only need the latest version, filter from cache
    if (loadLatestOnly) {
      const cachedVersions = versionCache.get(cacheKey);
      const latestStable = cachedVersions.find(v => v.isStable);
      if (latestStable) {
        return [latestStable];
      }
      return [cachedVersions[0]];
    }
    
    return versionCache.get(cacheKey);
  }
  
  // Apply rate limiting before API request
  await rateLimit();

  
  // Add timeout to prevent hanging
  const controller = new AbortController();
  const timeoutId = setTimeout(() => controller.abort(), 10000); // 10 second timeout
  
  let versions;
  try {
    const response = await fetch(`${MODRINTH_API}/project/${projectId}/version`, {
      signal: controller.signal
    });
    clearTimeout(timeoutId);
      if (!response.ok) {
      // Add specific diagnostics for 404 errors
      if (response.status === 404) {
        console.warn(`🔍 Mod API Diagnostic: Project ID "${projectId}" not found (404)`);
        console.warn(`   This could mean:`);
        console.warn(`   - The mod was removed from Modrinth`);
        console.warn(`   - The project ID is incorrect or outdated`);
        console.warn(`   - The mod might have been renamed or transferred`);
        console.warn(`   💡 User action: Try searching for this mod manually and re-installing it`);
        console.warn(`   🔗 Search URL: https://modrinth.com/mods?q=${encodeURIComponent(projectId)}`);
        
        // Return a user-friendly error message
        throw new Error(`Mod not found on Modrinth - the mod may have been removed or the project ID is outdated. Try re-installing this mod.`);
      }
      
      throw new Error(`Modrinth API error: ${response.status}`);
    }
    
    versions = await response.json();

  } catch (error) {
    clearTimeout(timeoutId);
    if (error.name === 'AbortError') {

      throw new Error(`API timeout for ${projectId}`);
    }
    throw error;
  }
  
  // Filter versions that match our requirements
  let compatibleVersions = versions;
  if (loader) {
    compatibleVersions = compatibleVersions.filter(v => v.loaders.includes(loader));
  }  if (gameVersion) {
    // Strict game version matching - only exact matches for the current version
    compatibleVersions = compatibleVersions.filter(v => {
      return v.game_versions.includes(gameVersion);
    });
  }
    
    // Map to a more user-friendly format
    let mappedVersions = compatibleVersions.map(v => ({
      id: v.id,
      name: v.name,
      versionNumber: v.version_number,
      gameVersions: v.game_versions,
      loaders: v.loaders,
      dependencies: v.dependencies || [],
      datePublished: v.date_published,
      isStable: !v.version_type.includes('alpha') && !v.version_type.includes('beta'),
      fileSize: v.files && v.files.length > 0 ? v.files[0].size : undefined,
      downloads: v.downloads || 0
    }));
    
    // Sort versions (newest first)
    mappedVersions.sort((a, b) => {
      const dateA = new Date(a.datePublished).getTime();
      const dateB = new Date(b.datePublished).getTime();
      return dateB - dateA;
    });
      // Cache the results
  versionCache.set(cacheKey, mappedVersions);
  
  // If we only need the latest version, select the best one for the target game version
  if (loadLatestOnly && mappedVersions.length > 0) {
    // When a specific game version is requested, prioritize versions with narrower compatibility
    if (gameVersion) {
      // Sort versions by compatibility specificity and date
      const sortedBySpecificity = [...mappedVersions].sort((a, b) => {        // First priority: prefer stable versions
        const aStable = a.isStable;
        const bStable = b.isStable;
        if (aStable !== bStable) {
          return bStable - aStable; // true (1) - false (0) = 1, so stable comes first
        }
        
        // Second priority: prefer newer versions by date
        const dateA = new Date(a.datePublished).getTime();
        const dateB = new Date(b.datePublished).getTime();
        if (dateA !== dateB) {
          return dateB - dateA; // newer versions first
        }
        
        // Third priority: prefer versions with fewer supported game versions (more specific)
        const aVersionCount = a.gameVersions.length;
        const bVersionCount = b.gameVersions.length;
        if (aVersionCount !== bVersionCount) {
          return aVersionCount - bVersionCount; // fewer versions = more specific
        }
          // Final priority: prefer versions that list the target version first (primary target)
        const aTargetIndex = a.gameVersions.indexOf(gameVersion);
        const bTargetIndex = b.gameVersions.indexOf(gameVersion);        return aTargetIndex - bTargetIndex; // lower index = earlier in list = primary target
      });
        
        return [sortedBySpecificity[0]];
      } else {
        // No specific game version, use original logic
        const latestStable = mappedVersions.find(v => v.isStable);
        if (latestStable) {
          return [latestStable];
        }
        return [mappedVersions[0]];
      }
    }
    
    return mappedVersions;
  }

/**
 * Get specific version info for a Modrinth mod
 * 
 * @param {string} projectId - Modrinth project ID (can be undefined if versionId is globally unique)
 * @param {string} versionId - Version ID
 * @returns {Promise<Object>} Version info object
 */
async function getModrinthVersionInfo(projectId, versionId, gameVersion, loader) {
  if (!versionId) {
    return await getLatestModrinthVersionInfo(projectId, gameVersion, loader);
  }

  await rateLimit();
  const response = await fetch(`${MODRINTH_API}/version/${versionId}`);

  if (!response.ok) {
    throw new Error(`Modrinth API error: ${response.status}`);
  }

  return await response.json();
}

/**
 * Get latest version info for a Modrinth mod
 * 
 * @param {string} projectId - Modrinth project ID
 * @param {string} gameVersion - Minecraft version
 * @param {string} loader - Mod loader (fabric, forge, etc.)
 * @returns {Promise<Object>} Version info object
 */
async function getLatestModrinthVersionInfo(projectId, gameVersion, loader) {
  try {
    // Get ALL compatible versions, not just the latest one, so we can find newer versions
    const versions = await getModrinthVersions(projectId, loader, gameVersion, false);
    if (!versions || versions.length === 0) {
      // No versions found, treat as no update available
      return null;
    }
    
    // Find the newest version (versions are already sorted by date, newest first)
    const latestVersion = versions[0];
    
    try {
      const latestVersionInfo = await getModrinthVersionInfo(projectId, latestVersion.id, gameVersion, loader);
      return latestVersionInfo;
    } catch (err) {
      // Skip on not found or no matching versions
      if (err.message.includes('Mod not found on Modrinth') || err.message.includes('No matching versions found')) {
        return null;
      }
      throw err;
    }
  } catch (err) {
    if (err.message.includes('Mod not found on Modrinth') || err.message.includes('No matching versions found')) {
      return null;
    }
    throw err;
  }
}

/**
 * Get popular mods from CurseForge
 * 
 * @param {Object} options - Search options
 * @param {string} options.loader - Mod loader (fabric, forge, etc.)
 * @param {string} options.version - Minecraft version
 * @param {number} options.page - Page number (1-based)
 * @param {number} options.limit - Results per page
 * @returns {Promise<Object>} Object with mods array and pagination info
 */
async function getCurseForgePopular({ page = 1, limit = 20 }) {
  // Return an empty result set
  return {
    mods: [],
    pagination: {
      currentPage: page,
      totalResults: 0,
      totalPages: 0,
      limit
    }
  };
}

/**
 * Search for mods on CurseForge
 * 
 * @param {Object} options - Search options
 * @param {string} options.query - Search query
 * @param {string} options.loader - Mod loader (fabric, forge, etc.)
 * @param {string} options.version - Minecraft version
 * @param {number} options.page - Page number (1-based)
 * @param {number} options.limit - Results per page
 * @returns {Promise<Object>} Object with mods array and pagination info
 */
async function searchCurseForgeMods({ page = 1, limit = 20 }) {
  // Return an empty result set
  return {
    mods: [],
    pagination: {
      currentPage: page,
      totalResults: 0,
      totalPages: 0,
      limit
    }
  };
}

/**
 * Get download URL for a CurseForge mod
 * 
 * @returns {Promise<string>} Download URL
 */
async function getCurseForgeDownloadUrl() {
  throw new Error('CurseForge support not implemented');
}

module.exports = {
  rateLimit,
  clearVersionCache,
  convertSortToModrinthFormat,
  getModrinthPopular,
  searchModrinthMods,
  formatModVersions,
  getModrinthDownloadUrl,
  getModrinthProjectInfo,
  getModInfo,
  resolveModrinthDependencies,
  getModrinthVersions,
  getModrinthVersionInfo,
  getLatestModrinthVersionInfo,
  getCurseForgePopular,
  searchCurseForgeMods,
  getCurseForgeDownloadUrl
};
