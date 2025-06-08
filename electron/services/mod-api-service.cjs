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
    console.log(`[API] Rate limiting: Waiting ${delay}ms before next request`);
    await new Promise(resolve => setTimeout(resolve, delay));
  }
  
  lastRequestTime = Date.now();
}

// Version cache to reduce API calls
const versionCache = new Map();

/**
 * Helper function to convert our sort options to Modrinth API format
 * @param {string} sortBy - Sort option
 * @returns {string} - Converted sort option
 */
function convertSortToModrinthFormat(sortBy) {
  console.log(`[API:Modrinth] Converting sort parameter: "${sortBy}"`);
  
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
      console.log(`[API:Modrinth] Unknown sort value: "${sortBy}", defaulting to relevance`);
      modrinthSort = 'relevance';
  }
  
  console.log(`[API:Modrinth] Converted sort parameter to: "${modrinthSort}"`);
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
async function getModrinthPopular({ loader, version, page = 1, limit = 20, sortBy = 'relevance', environmentType = 'all' }) {
  await rateLimit();
  
  console.log(`[API:Modrinth] getModrinthPopular called with sortBy="${sortBy}" and environmentType="${environmentType}"`);
  
  const modrinthSortBy = convertSortToModrinthFormat(sortBy);
  
  // Build the facets array
  const facets = [];
  if (loader) {
    facets.push([`categories:${loader}`]);
  }
  if (version) {
    facets.push(["versions:" + version]);
  }
  
  // Add environment type facet if specified
  if (environmentType !== 'all') {
    // Convert our environment types to Modrinth's format
    if (environmentType === 'client') {
      // For client-side, include both 'required' and 'optional' to catch all client-compatible mods
      facets.push(['client_side:required', 'client_side:optional']);
    } else if (environmentType === 'server') {
      // For server-side, include both 'required' and 'optional' to catch all server-compatible mods
      facets.push(['server_side:required', 'server_side:optional']);
    } else if (environmentType === 'both') {
      // For "both", we need mods that work on both client and server
      // Use separate AND condition with both client and server support
      facets.push(['client_side:required', 'client_side:optional']);
      facets.push(['server_side:required', 'server_side:optional']);
    }
  }
  
  // Convert facets to JSON string
  const facetsParam = JSON.stringify(facets);
  
  // Build request URL
  const url = new URL(`${MODRINTH_API}/search`);
  url.searchParams.append('offset', (page - 1) * limit);
  url.searchParams.append('limit', limit);
  url.searchParams.append('facets', facetsParam);
  
  // Add sorting parameter in multiple formats to ensure compatibility
  url.searchParams.append('index', modrinthSortBy);  // For newer API versions
  
  // Execute request
  console.log(`[API:Modrinth] Fetching popular mods with index=${modrinthSortBy}, facets=${facetsParam}, page=${page}, limit=${limit}, environmentType=${environmentType}`);
  console.log(`[API:Modrinth] Full URL: ${url.toString()}`);
  
  try {
    const response = await fetch(url.toString(), {
      headers: {
        'User-Agent': 'minecraft-core/1.0.0'
      }
    });
    
    if (!response.ok) {
      console.error(`[API:Modrinth] Error response: ${response.status} ${response.statusText}`);
      throw new Error(`Modrinth API error: ${response.status}`);
    }
    
    const data = await response.json();
    console.log(`[API:Modrinth] Got ${data.hits?.length || 0} results, total hits: ${data.total_hits || 0}`);
    
    // Debug: Log first few results to check if they're actually sorted correctly
    if (data.hits && data.hits.length > 0) {
      console.log(`[API:Modrinth] First result: ${data.hits[0].title}, Downloads: ${data.hits[0].downloads}, Follows: ${data.hits[0].follows}`);
      if (data.hits.length > 1) {
        console.log(`[API:Modrinth] Second result: ${data.hits[1].title}, Downloads: ${data.hits[1].downloads}, Follows: ${data.hits[1].follows}`);
      }
    }
    
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
  } catch (error) {
    console.error('Modrinth API error:', error);
    throw error;
  }
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
async function searchModrinthMods({ query, loader, version, page = 1, limit = 20, sortBy = 'relevance', environmentType = 'all' }) {
  console.log('[API:Service] Searching mods with:', { keyword: query, loader, version, source: 'modrinth', page, limit, sortBy, environmentType });
  
  await rateLimit();
  
  console.log(`[API:Modrinth] searchModrinthMods called with sortBy="${sortBy}" and environmentType="${environmentType}"`);
  
  const modrinthSortBy = convertSortToModrinthFormat(sortBy);
  
  // Build the facets array
  const facets = [];
  if (loader) {
    facets.push([`categories:${loader}`]);
  }
  if (version) {
    facets.push(["versions:" + version]);
  }
  
  // Add environment type facet if specified
  if (environmentType !== 'all') {
    // Convert our environment types to Modrinth's format
    if (environmentType === 'client') {
      // For client-side, include both 'required' and 'optional' to catch all client-compatible mods
      facets.push(['client_side:required', 'client_side:optional']);
    } else if (environmentType === 'server') {
      // For server-side, include both 'required' and 'optional' to catch all server-compatible mods
      facets.push(['server_side:required', 'server_side:optional']);
    } else if (environmentType === 'both') {
      // For "both", we need mods that work on both client and server
      // Use separate AND condition with both client and server support
      facets.push(['client_side:required', 'client_side:optional']);
      facets.push(['server_side:required', 'server_side:optional']);
    }
  }
  
  // Convert facets to JSON string
  const facetsParam = JSON.stringify(facets);
  
  // Build request URL
  const url = new URL(`${MODRINTH_API}/search`);
  url.searchParams.append('query', query);
  url.searchParams.append('offset', (page - 1) * limit);
  url.searchParams.append('limit', limit);
  url.searchParams.append('facets', facetsParam);
  
  // Add sorting parameter in multiple formats to ensure compatibility
  url.searchParams.append('index', modrinthSortBy);  // For newer API versions
  
  // Execute request
  console.log(`[API:Modrinth] Searching mods with query="${query}", index=${modrinthSortBy}, facets=${facetsParam}, page=${page}, limit=${limit}, environmentType=${environmentType}`);
  console.log(`[API:Modrinth] Full URL: ${url.toString()}`);
  
  try {
    const response = await fetch(url.toString(), {
      headers: {
        'User-Agent': 'minecraft-core/1.0.0'
      }
    });
    
    if (!response.ok) {
      console.error(`[API:Modrinth] Error response: ${response.status} ${response.statusText}`);
      throw new Error(`Modrinth API error (${response.status}): ${response.statusText}`);
    }
    
    const data = await response.json();
    console.log(`[API:Modrinth] Got ${data.hits?.length || 0} results, total hits: ${data.total_hits || 0}`);
    
    // Debug: Log first few results to check if they're actually sorted correctly
    if (data.hits && data.hits.length > 0) {
      console.log(`[API:Modrinth] First result: ${data.hits[0].title}, Downloads: ${data.hits[0].downloads}, Follows: ${data.hits[0].follows}`);
      if (data.hits.length > 1) {
        console.log(`[API:Modrinth] Second result: ${data.hits[1].title}, Downloads: ${data.hits[1].downloads}, Follows: ${data.hits[1].follows}`);
      }
    }
    
    // Process results
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
  } catch (error) {
    console.error('[API:Service] Error searching Modrinth mods:', error);
    throw error;
  }
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
  try {
    const versions = await getModrinthVersions(projectId, loader, version);
    
    if (versions.length === 0) {
      throw new Error('No matching versions found for this mod');
    }
    
    // Get latest version
    const latest = versions[0];
    
    // Get the full version info
    const versionInfo = await getModrinthVersionInfo(projectId, latest.id, gameVersion, loader);
    
    // Get primary file
    if (!versionInfo.files || versionInfo.files.length === 0) {
      throw new Error('No files found for this mod version');
    }
    
    const primaryFile = versionInfo.files.find(file => file.primary) || versionInfo.files[0];
    return primaryFile.url;
  } catch (error) {
    console.error('Modrinth download URL error:', error);
    throw error;
  }
}

/**
 * Get information about a Modrinth mod project
 * 
 * @param {string} projectId - Modrinth project ID
 * @returns {Promise<Object>} Project info
 */
async function getModrinthProjectInfo(projectId) {
  try {
    await rateLimit(); // Ensure rate limiting
    const response = await fetch(`${MODRINTH_API}/project/${projectId}`);
    
    if (!response.ok) {
      throw new Error(`Modrinth API error: ${response.status}`);
    }
    
    return await response.json();
  } catch (error) {
    console.error('Modrinth project info error:', error);
    throw error;
  }
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
        // Get project info to get the name
        const projectInfo = await getModrinthProjectInfo(dep.project_id);
        
        resolvedDeps.push({
          projectId: dep.project_id,
          name: projectInfo.title,
          dependencyType: dep.dependency_type
        });
      } catch (error) {
        console.error(`[API:Service] Failed to resolve dependency ${dep.project_id}:`, error);
        // Include the dependency even if we can't resolve its name
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
async function getModrinthVersions(projectId, loader, gameVersion, loadLatestOnly = false) {
  try {
    // Check cache first
    const cacheKey = `${projectId}:${loader || ''}:${gameVersion || ''}`;
    if (versionCache.has(cacheKey)) {
      console.log(`[API:Service] Using cached versions for ${projectId}`);
      
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
    
    const response = await fetch(`${MODRINTH_API}/project/${projectId}/version`);
    
    if (!response.ok) {
      throw new Error(`Modrinth API error: ${response.status}`);
    }
    
    const versions = await response.json();
    
    // Filter versions that match our requirements
    let compatibleVersions = versions;
    
    if (loader) {
      compatibleVersions = compatibleVersions.filter(v => v.loaders.includes(loader));
    }
    
    if (gameVersion) {
      compatibleVersions = compatibleVersions.filter(v => v.game_versions.includes(gameVersion));
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
        const sortedBySpecificity = [...mappedVersions].sort((a, b) => {
          // First priority: prefer stable versions
          const aStable = a.isStable;
          const bStable = b.isStable;
          if (aStable !== bStable) {
            return bStable - aStable; // true (1) - false (0) = 1, so stable comes first
          }
          
          // Second priority: prefer versions with fewer supported game versions (more specific)
          const aVersionCount = a.gameVersions.length;
          const bVersionCount = b.gameVersions.length;
          if (aVersionCount !== bVersionCount) {
            return aVersionCount - bVersionCount; // fewer versions = more specific
          }
          
          // Third priority: prefer versions that list the target version first (primary target)
          const aTargetIndex = a.gameVersions.indexOf(gameVersion);
          const bTargetIndex = b.gameVersions.indexOf(gameVersion);
          if (aTargetIndex !== bTargetIndex) {
            return aTargetIndex - bTargetIndex; // lower index = earlier in list = primary target
          }
          
          // Final priority: newer versions
          const dateA = new Date(a.datePublished).getTime();
          const dateB = new Date(b.datePublished).getTime();
          return dateB - dateA;
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
  } catch (error) {
    console.error('Modrinth versions error:', error);
    throw error;
  }
}

/**
 * Get specific version info for a Modrinth mod
 * 
 * @param {string} projectId - Modrinth project ID (can be undefined if versionId is globally unique)
 * @param {string} versionId - Version ID
 * @returns {Promise<Object>} Version info object
 */
async function getModrinthVersionInfo(projectId, versionId, gameVersion, loader) { // projectId not strictly needed for /version/{id}
  try {
    // If no version ID provided, fall back to latest version info
    if (!versionId) {
      return await getLatestModrinthVersionInfo(projectId, gameVersion, loader);
    }

    await rateLimit(); // Ensure rate limiting
    const response = await fetch(`${MODRINTH_API}/version/${versionId}`);

    if (!response.ok) {
      throw new Error(`Modrinth API error: ${response.status}`);
    }

    return await response.json();
  } catch (error) {
    // Only log as error if it's not a 404 (which can be normal for missing/removed versions)
    if (error.message && error.message.includes('404')) {
      console.warn('Modrinth version not found (404):', versionId);
    } else {
      console.error('Modrinth version info error:', error);
    }
    throw error;
  }
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
    const versions = await getModrinthVersions(projectId, loader, gameVersion, true); // Get only latest
    
    if (!versions || versions.length === 0) {
      throw new Error('No matching versions found');
    }
    
    // The getModrinthVersions with loadLatestOnly should already return the single best version.
    // Now fetch its full details.
    return await getModrinthVersionInfo(projectId, versions[0].id, gameVersion, loader);
  } catch (error) {
    console.error('Modrinth latest version info error:', error);
    throw error;
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
async function getCurseForgePopular({ loader, version, page = 1, limit = 20, environmentType = 'all' }) {
  console.log('[API:Service] CurseForge support not implemented for getPopular');
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
async function searchCurseForgeMods({ query, loader, version, page = 1, limit = 20, environmentType = 'all' }) {
  console.log('[API:Service] CurseForge support not implemented for searchMods');
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
 * @param {string} modId - CurseForge mod ID
 * @param {string} version - Minecraft version
 * @param {string} loader - Mod loader (fabric, forge, etc.)
 * @returns {Promise<string>} Download URL
 */
async function getCurseForgeDownloadUrl(modId, version, loader) {
  console.log('[API:Service] CurseForge support not implemented for getDownloadUrl');
  throw new Error('CurseForge support not implemented');
}

module.exports = {
  rateLimit,
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
