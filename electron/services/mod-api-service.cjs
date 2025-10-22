// Mod API service functions
const fetch = require('node-fetch');
const { getLoggerHandlers } = require('../ipc/logger-handlers.cjs');

// Initialize logger
const logger = getLoggerHandlers();

// Modrinth API base URL
const MODRINTH_API = 'https://api.modrinth.com/v2';

// Add a rate limiter utility
const RATE_LIMIT_MS = 500; // Delay between API requests
let lastRequestTime = 0;

// Performance tracking
let performanceMetrics = {
  apiRequests: 0,
  cacheHits: 0,
  cacheMisses: 0,
  retryAttempts: 0,
  rateLimitDelays: 0,
  totalDelayTime: 0
};

// Log service initialization
logger.info('Mod API service initialized', {
  category: 'network',
  data: {
    service: 'ModApiService',
    modrinthApi: MODRINTH_API,
    rateLimitMs: RATE_LIMIT_MS,
    cacheSize: 0
  }
});

/**
 * Simple rate limiter that ensures a minimum delay between API requests
 * @returns {Promise<void>} Resolves when it's safe to make another request
 */
async function rateLimit() {
  const now = Date.now();
  const elapsed = now - lastRequestTime;
  
  if (elapsed < RATE_LIMIT_MS && lastRequestTime > 0) {
    const delay = RATE_LIMIT_MS - elapsed;
    performanceMetrics.rateLimitDelays++;
    performanceMetrics.totalDelayTime += delay;
    
    logger.debug('Rate limiting API request', {
      category: 'network',
      data: {
        service: 'ModApiService',
        operation: 'rateLimit',
        delayMs: delay,
        elapsedMs: elapsed,
        rateLimitMs: RATE_LIMIT_MS,
        totalDelays: performanceMetrics.rateLimitDelays,
        totalDelayTime: performanceMetrics.totalDelayTime
      }
    });
    
    await new Promise(resolve => setTimeout(resolve, delay));
  }
  
  lastRequestTime = Date.now();
}

// Version cache to reduce API calls
const versionCache = new Map();

/**
 * Retry function with exponential backoff for API calls
 * @param {Function} fn - The function to retry
 * @param {number} maxRetries - Maximum number of retries
 * @param {number} baseDelay - Base delay in milliseconds
 * @returns {Promise<any>} - Result of the function
 */
async function retryWithBackoff(fn, maxRetries = 3, baseDelay = 1000) {
  let lastError;
  const retryStartTime = Date.now();
  
  for (let attempt = 0; attempt <= maxRetries; attempt++) {
    try {
      const result = await fn();
      
      if (attempt > 0) {
        const retryDuration = Date.now() - retryStartTime;
        logger.info('API request succeeded after retry', {
          category: 'network',
          data: {
            service: 'ModApiService',
            operation: 'retryWithBackoff',
            attempt: attempt + 1,
            maxRetries: maxRetries + 1,
            duration: retryDuration,
            totalRetryAttempts: performanceMetrics.retryAttempts
          }
        });
      }
      
      return result;
    } catch (error) {
      lastError = error;
      performanceMetrics.retryAttempts++;
      
      // Don't retry on 404 errors (mod not found)
      if (error.message && error.message.includes('404')) {
        logger.debug('Not retrying 404 error', {
          category: 'network',
          data: {
            service: 'ModApiService',
            operation: 'retryWithBackoff',
            attempt: attempt + 1,
            errorType: '404',
            errorMessage: error.message
          }
        });
        throw error;
      }
      
      // Don't retry on final attempt
      if (attempt === maxRetries) {
        break;
      }
      
      // Calculate delay with exponential backoff
      const delay = baseDelay * Math.pow(2, attempt);
      
      logger.warn('API request failed, retrying with backoff', {
        category: 'network',
        data: {
          service: 'ModApiService',
          operation: 'retryWithBackoff',
          attempt: attempt + 1,
          maxRetries: maxRetries + 1,
          delayMs: delay,
          errorType: error.constructor.name,
          errorMessage: error.message,
          totalRetryAttempts: performanceMetrics.retryAttempts
        }
      });
      
      await new Promise(resolve => setTimeout(resolve, delay));
    }
  }
  
  const retryDuration = Date.now() - retryStartTime;
  logger.error('API request failed after all retry attempts', {
    category: 'network',
    data: {
      service: 'ModApiService',
      operation: 'retryWithBackoff',
      totalAttempts: maxRetries + 1,
      duration: retryDuration,
      finalError: lastError.message,
      errorType: lastError.constructor.name
    }
  });
  
  throw lastError;
}

/**
 * Clear the version cache - useful when checking compatibility for different versions
 */
function clearVersionCache() {
  const cacheSize = versionCache.size;
  versionCache.clear();
  
  logger.info('Version cache cleared', {
    category: 'mods',
    data: {
      service: 'ModApiService',
      operation: 'clearVersionCache',
      clearedEntries: cacheSize,
      newCacheSize: versionCache.size
    }
  });
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
  
  logger.debug('Sort option converted for Modrinth API', {
    category: 'mods',
    data: {
      service: 'ModApiService',
      operation: 'convertSortToModrinthFormat',
      inputSort: sortBy,
      outputSort: modrinthSort,
      wasDefault: sortBy !== modrinthSort
    }
  });
  
  return modrinthSort;
}
/**
 * Helper function to filter mods by environment type (client, server, both).
 * @param {Array<Object>} mods - Array of mod objects
 * @param {string} environmentType - 'all' | 'client' | 'server' | 'both'
 * @returns {Array<Object>} Filtered mods array
 */
function filterModsByEnvironment(mods, environmentType = 'all') {
  if (!Array.isArray(mods) || environmentType === 'all') {
    logger.debug('No environment filtering applied', {
      category: 'mods',
      data: {
        service: 'ModApiService',
        operation: 'filterModsByEnvironment',
        environmentType,
        inputCount: Array.isArray(mods) ? mods.length : 0,
        outputCount: Array.isArray(mods) ? mods.length : 0,
        filtered: false
      }
    });
    return mods;
  }
  
  let filteredMods;
  switch (environmentType) {
    case 'client':
      // Accept any mod that can run on the client (required OR optional)
      filteredMods = mods.filter(m => m.clientSide);
      break;
    case 'server':
      // Accept any mod that can run on the server (required OR optional)
      filteredMods = mods.filter(m => m.serverSide);
      break;
    case 'both':
      // Only mods explicitly supporting both sides
      filteredMods = mods.filter(m => m.clientSide && m.serverSide);
      break;
    default:
      filteredMods = mods;
  }
  
  logger.debug('Mods filtered by environment', {
    category: 'mods',
    data: {
      service: 'ModApiService',
      operation: 'filterModsByEnvironment',
      environmentType,
      inputCount: mods.length,
      outputCount: filteredMods.length,
      filtered: true,
      filteredOut: mods.length - filteredMods.length
    }
  });
  
  return filteredMods;
}

/**
 * Get popular content from Modrinth
 * 
 * @param {Object} options - Search options
 * @param {string} options.loader - Mod loader (fabric, forge, etc.)
 * @param {string} options.version - Minecraft version
 * @param {number} options.page - Page number (1-based)
 * @param {number} options.limit - Results per page
 * @param {string} options.sortBy - Sort method (popular, recent, downloads, name)
 * @param {string} [options.environmentType='all'] - Filter by environment type ('all', 'client', 'server', 'both')
 * @param {string} [options.projectType='mod'] - Project type ('mod', 'shader', 'resourcepack')
 * @returns {Promise<Object>} Object with content array and pagination info
 */
async function getModrinthPopular({ loader, version, page = 1, limit = 20, sortBy = 'relevance', environmentType = 'all', projectType = 'mod' }) {
  const requestStartTime = Date.now();
  
  logger.info('Fetching popular mods from Modrinth', {
    category: 'network',
    data: {
      service: 'ModApiService',
      operation: 'getModrinthPopular',
      loader,
      version,
      page,
      limit,
      sortBy,
      environmentType,
      projectType
    }
  });
  
  await rateLimit();
  performanceMetrics.apiRequests++;
  
  const modrinthSortBy = convertSortToModrinthFormat(sortBy);
  
  // Build the facets array
  const facets = [];
  
  // Add project type facet
  if (projectType) {
    facets.push([`project_type:${projectType}`]);
  }
  
  if (loader) {
    facets.push([`categories:${loader}`]);
  }
  if (version) {
    facets.push(["versions:" + version]);
  }
  // Add environment facet filters based on environmentType
  if (environmentType === 'client') {
    facets.push([
      'client_side:required',
      'client_side:optional'
    ]);
  } else if (environmentType === 'server') {
    facets.push([
      'server_side:required',
      'server_side:optional'
    ]);
  } else if (environmentType === 'both') {
    facets.push([
      'client_side:required',
      'client_side:optional'
    ]);
    facets.push([
      'server_side:required',
      'server_side:optional'
    ]);
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
  
  logger.debug('Modrinth API request prepared', {
    category: 'network',
    data: {
      service: 'ModApiService',
      operation: 'getModrinthPopular',
      url: url.toString(),
      facets,
      facetsParam,
      offset: (page - 1) * limit,
      sortBy: modrinthSortBy
    }
  });
  // Execute request with retry logic
  const data = await retryWithBackoff(async () => {
    const controller = new AbortController();
    const timeoutId = setTimeout(() => controller.abort(), 20000); // 10 second timeout
    
    try {
      const response = await fetch(url.toString(), {
        headers: {
          'User-Agent': 'minecraft-core/1.0.0'
        },
        signal: controller.signal
      });
      clearTimeout(timeoutId);

      if (!response.ok) {
        throw new Error(`Modrinth API error: ${response.status}`);
      }

      const responseData = await response.json();
      
      logger.debug('Modrinth API response received', {
        category: 'network',
        data: {
          service: 'ModApiService',
          operation: 'getModrinthPopular',
          statusCode: response.status,
          totalHits: responseData.total_hits,
          hitsReturned: responseData.hits?.length || 0,
          responseSize: JSON.stringify(responseData).length
        }
      });
      
      return responseData;
    } catch (error) {
      clearTimeout(timeoutId);
      if (error.name === 'AbortError') {
        throw new Error(`API timeout during popular mods fetch - network may be slow or API unavailable`);
      }
      throw error;
    }
  });

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
    
    const requestDuration = Date.now() - requestStartTime;
    const result = {
      mods,
      pagination: {
        currentPage: page,
        totalResults: data.total_hits,
        totalPages: Math.ceil(data.total_hits / limit),
        limit
      }
    };
    
    logger.info('Popular mods fetched successfully', {
      category: 'network',
      data: {
        service: 'ModApiService',
        operation: 'getModrinthPopular',
        duration: requestDuration,
        modsReturned: mods.length,
        totalResults: data.total_hits,
        currentPage: page,
        totalPages: result.pagination.totalPages,
        totalApiRequests: performanceMetrics.apiRequests
      }
    });
    
    return result;
}

/**
 * Search for content on Modrinth
 * 
 * @param {Object} options - Search options
 * @param {string} options.query - Search query
 * @param {string} options.loader - Mod loader (fabric, forge, etc.)
 * @param {string} options.version - Minecraft version
 * @param {number} options.page - Page number (1-based)
 * @param {number} options.limit - Number of results per page
 * @param {string} [options.sortBy='relevance'] - Sort by option
 * @param {string} [options.environmentType='all'] - Filter by environment type ('all', 'client', 'server', 'both')
 * @param {string} [options.projectType='mod'] - Project type ('mod', 'shader', 'resourcepack')
 * @returns {Promise<Object>} Object with content array and pagination info
 */
async function searchModrinthMods({ query, loader, version, page = 1, limit = 20, sortBy = 'relevance', environmentType = 'all', projectType = 'mod' }) {
  const searchStartTime = Date.now();
  
  logger.info('Searching mods on Modrinth', {
    category: 'network',
    data: {
      service: 'ModApiService',
      operation: 'searchModrinthMods',
      query,
      loader,
      version,
      page,
      limit,
      sortBy,
      environmentType,
      projectType
    }
  });
  
  await rateLimit();
  performanceMetrics.apiRequests++;
  
  
  const modrinthSortBy = convertSortToModrinthFormat(sortBy);
  
  // Build the facets array
  const facets = [];
  
  // Add project type facet
  if (projectType) {
    facets.push([`project_type:${projectType}`]);
  }
  
  if (loader) {
    facets.push([`categories:${loader}`]);
  }
  if (version) {
    facets.push(["versions:" + version]);
  }
  // Add environment facet filters based on environmentType
  if (environmentType === 'client') {
    facets.push([
      'client_side:required',
      'client_side:optional'
    ]);
  } else if (environmentType === 'server') {
    facets.push([
      'server_side:required',
      'server_side:optional'
    ]);
  } else if (environmentType === 'both') {
    facets.push([
      'client_side:required',
      'client_side:optional'
    ]);
    facets.push([
      'server_side:required',
      'server_side:optional'
    ]);
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
  // Execute request with retry logic
  const data = await retryWithBackoff(async () => {
    const controller = new AbortController();
    const timeoutId = setTimeout(() => controller.abort(), 20000); // 10 second timeout
    
    try {
      const response = await fetch(url.toString(), {
        headers: {
          'User-Agent': 'minecraft-core/1.0.0'
        },
        signal: controller.signal
      });
      clearTimeout(timeoutId);

      if (!response.ok) {
        throw new Error(`Modrinth API error (${response.status}): ${response.statusText}`);
      }

      const responseData = await response.json();
      
      logger.debug('Modrinth search response received', {
        category: 'network',
        data: {
          service: 'ModApiService',
          operation: 'searchModrinthMods',
          query,
          statusCode: response.status,
          totalHits: responseData.total_hits,
          hitsReturned: responseData.hits?.length || 0
        }
      });
      
      return responseData;
    } catch (error) {
      clearTimeout(timeoutId);
      if (error.name === 'AbortError') {
        throw new Error(`API timeout during mod search - network may be slow or API unavailable`);
      }
      throw error;
    }
  });

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
    
    const searchDuration = Date.now() - searchStartTime;
    const result = {
      mods,
      pagination: {
        totalResults: data.total_hits,
        totalPages: Math.ceil(data.total_hits / limit),
        currentPage: page
      }
    };
    
    logger.info('Mod search completed successfully', {
      category: 'network',
      data: {
        service: 'ModApiService',
        operation: 'searchModrinthMods',
        duration: searchDuration,
        query,
        modsReturned: mods.length,
        totalResults: data.total_hits,
        currentPage: page,
        totalPages: result.pagination.totalPages,
        totalApiRequests: performanceMetrics.apiRequests
      }
    });
    
    return result;
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
  if (!projectId) {
    throw new Error('Project ID is required');
  }

  await rateLimit();
  
  return await retryWithBackoff(async () => {
    const controller = new AbortController();
    const timeoutId = setTimeout(() => controller.abort(), 20000); // 10 second timeout
    
    try {
      const response = await fetch(`${MODRINTH_API}/project/${projectId}`, {
        signal: controller.signal
      });
      clearTimeout(timeoutId);

      if (!response.ok) {
        throw new Error(`Modrinth API error: ${response.status}`);
      }

      return await response.json();
    } catch (error) {
      clearTimeout(timeoutId);
      if (error.name === 'AbortError') {
        throw new Error(`API timeout for project ${projectId} - network may be slow or API unavailable`);
      }
      if (error.response && error.response.status === 404) {
        // TODO: Add proper logging - Project ID not found (404)
        return null;
      }
      throw error;
    }
  });
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
async function getModrinthVersions(projectId, loader, gameVersion, loadLatestOnly = false) {
  const versionsStartTime = Date.now();
  const traceId = `${projectId}-${Date.now()}-${Math.floor(Math.random()*1000)}`;
  
  // Check cache first
  const cacheKey = `${projectId}:${loader || ''}:${gameVersion || ''}`;
  if (versionCache.has(cacheKey)) {
    performanceMetrics.cacheHits++;
    
    logger.debug('Version cache hit', {
      category: 'mods',
      data: {
        service: 'ModApiService',
        operation: 'getModrinthVersions',
        projectId,
        loader,
        gameVersion,
        loadLatestOnly,
        cacheKey,
        totalCacheHits: performanceMetrics.cacheHits
      }
    });
    
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
  
  performanceMetrics.cacheMisses++;
  
  logger.debug('Version cache miss, fetching from API', {
    category: 'mods',
    data: {
      service: 'ModApiService',
      operation: 'getModrinthVersions',
      projectId,
      loader,
      gameVersion,
      loadLatestOnly,
      cacheKey,
      totalCacheMisses: performanceMetrics.cacheMisses
    }
  });
  // Apply rate limiting before API request
  await rateLimit();
  performanceMetrics.apiRequests++;

  // Wrap the API call in retry logic
  const versions = await retryWithBackoff(async () => {
    // Add timeout to prevent hanging
    const controller = new AbortController();
    const timeoutId = setTimeout(() => controller.abort(), 15000); // Increased to 15 second timeout
    
    try {
      const response = await fetch(`${MODRINTH_API}/project/${projectId}/version`, {
        signal: controller.signal
      });
      clearTimeout(timeoutId);
      
      if (!response.ok) {
        // Add specific diagnostics for 404 errors
        if (response.status === 404) {
          logger.warn('Project not found on Modrinth', {
            category: 'network',
            data: {
              service: 'ModApiService',
              operation: 'getModrinthVersions',
              projectId,
              statusCode: 404,
              loader,
              gameVersion
            }
          });
          // Return a user-friendly error message
          throw new Error(`Mod not found on Modrinth - the mod may have been removed or the project ID is outdated. Try re-installing this mod.`);
        }
        
        throw new Error(`Modrinth API error: ${response.status}`);
      }
      
      const responseData = await response.json();
      
      logger.debug('Modrinth versions response received', {
        category: 'network',
        data: {
          service: 'ModApiService',
          operation: 'getModrinthVersions',
          projectId,
          statusCode: response.status,
          versionsReturned: responseData.length,
          loader,
          gameVersion,
          sample: responseData.slice(0, 5).map(v => ({ id: v.id, num: v.version_number, gv: v.game_versions.slice(0,3), loaders: v.loaders }))
        }
      });
      
      return responseData;

    } catch (error) {
      clearTimeout(timeoutId);
      if (error.name === 'AbortError') {
        throw new Error(`API timeout for ${projectId} - network may be slow or API unavailable`);
      }
      throw error;
    }
  });
  
  // Helper utilities for version filtering
  const normalizeVersionString = value => String(value || '').trim().toLowerCase();
  const targetVersionNormalized = normalizeVersionString(gameVersion);

  const parseVersionSegments = versionValue => {
    const matches = String(versionValue || '').toLowerCase().match(/\d+|x/g);
    if (!matches) {
      return [];
    }
    return matches.map(segment => segment === 'x' ? Number.NaN : parseInt(segment, 10));
  };

  const compareVersions = (a, b) => {
    const aSegments = parseVersionSegments(a);
    const bSegments = parseVersionSegments(b);
    const maxLength = Math.max(aSegments.length, bSegments.length);

    for (let i = 0; i < maxLength; i++) {
      const aValue = aSegments[i];
      const bValue = bSegments[i];

      if (aValue === undefined && bValue === undefined) {
        return 0;
      }

      if (Number.isNaN(aValue) || Number.isNaN(bValue)) {
        // Treat wildcard segments as matching any value
        continue;
      }

      const normalizedA = aValue === undefined ? 0 : aValue;
      const normalizedB = bValue === undefined ? 0 : bValue;

      if (normalizedA > normalizedB) {
        return 1;
      }
      if (normalizedA < normalizedB) {
        return -1;
      }
    }

    return 0;
  };

  const comparisonRegex = /^(>=|<=|>|<|==|=|!=)\s*(.+)$/;

  const satisfiesComparisonExpression = (expression, target) => {
    if (!expression) {
      return false;
    }

    const trimmedExpression = expression.trim();
    if (!trimmedExpression) {
      return false;
    }

    const tokens = trimmedExpression.split(/\s+/).filter(Boolean);
    if (tokens.length > 1 && tokens.every(token => comparisonRegex.test(token))) {
      return tokens.every(token => satisfiesComparisonExpression(token, target));
    }

    const comparisonMatch = trimmedExpression.match(comparisonRegex);
    if (comparisonMatch) {
      const [, operator, comparisonValue] = comparisonMatch;
      const comparisonResult = compareVersions(target, comparisonValue);
      switch (operator) {
        case '>=':
          return comparisonResult >= 0;
        case '>':
          return comparisonResult > 0;
        case '<=':
          return comparisonResult <= 0;
        case '<':
          return comparisonResult < 0;
        case '=':
        case '==':
          return comparisonResult === 0;
        case '!=':
          return comparisonResult !== 0;
        default:
          return false;
      }
    }

    const hyphenRangeMatch = trimmedExpression.match(/^(\d[\d.x]*)\s*-\s*(\d[\d.x]*)$/);
    if (hyphenRangeMatch) {
      const [, lower, upper] = hyphenRangeMatch;
      return compareVersions(target, lower) >= 0 && compareVersions(target, upper) <= 0;
    }

    if ((trimmedExpression.startsWith('[') || trimmedExpression.startsWith('(')) &&
        (trimmedExpression.endsWith(']') || trimmedExpression.endsWith(')'))) {
      const startBracket = trimmedExpression[0];
      const endBracket = trimmedExpression[trimmedExpression.length - 1];
      const inner = trimmedExpression.slice(1, -1);
      const parts = inner.split(',');
      if (parts.length === 2) {
        const lower = parts[0].trim();
        const upper = parts[1].trim();
        const lowerOk = startBracket === '[' ? compareVersions(target, lower) >= 0 : compareVersions(target, lower) > 0;
        const upperOk = endBracket === ']' ? compareVersions(target, upper) <= 0 : compareVersions(target, upper) < 0;
        if (lowerOk && upperOk) {
          return true;
        }
      }
    }

    return false;
  };

  const doesVersionTagApply = (tag, target) => {
    if (!tag || !target) {
      return false;
    }

    const normalizedTag = normalizeVersionString(tag);
    if (!normalizedTag) {
      return false;
    }

    const compoundParts = normalizedTag
      .split(/[,|]/)
      .map(part => part.trim())
      .filter(Boolean);

    if (compoundParts.length > 1) {
      return compoundParts.some(part => doesVersionTagApply(part, target));
    }

    if (normalizedTag === target) {
      return true;
    }

    if (normalizedTag.includes('.x') || normalizedTag.includes('.*')) {
      const base = normalizedTag.replace(/\.[x*].*$/, '');
      return target.startsWith(`${base}.`);
    }

    if (normalizedTag.startsWith('~')) {
      const approx = normalizedTag.substring(1);
      const approxParts = approx.split('.');
      const targetParts = target.split('.');
      if (approxParts.length >= 2) {
        return approxParts[0] === targetParts[0] && approxParts[1] === targetParts[1];
      }
      return approxParts[0] === targetParts[0];
    }

    if (comparisonRegex.test(normalizedTag)) {
      return satisfiesComparisonExpression(normalizedTag, target);
    }

    const hyphenRangeMatch = normalizedTag.match(/^(\d[\d.x]*)\s*-\s*(\d[\d.x]*)$/);
    if (hyphenRangeMatch) {
      const [, lower, upper] = hyphenRangeMatch;
      return compareVersions(target, lower) >= 0 && compareVersions(target, upper) <= 0;
    }

    if ((normalizedTag.startsWith('[') || normalizedTag.startsWith('(')) &&
        (normalizedTag.endsWith(']') || normalizedTag.endsWith(')'))) {
      const startBracket = normalizedTag[0];
      const endBracket = normalizedTag[normalizedTag.length - 1];
      const inner = normalizedTag.slice(1, -1);
      const parts = inner.split(',');
      if (parts.length === 2) {
        const lower = parts[0].trim();
        const upper = parts[1].trim();
        const lowerOk = startBracket === '[' ? compareVersions(target, lower) >= 0 : compareVersions(target, lower) > 0;
        const upperOk = endBracket === ']' ? compareVersions(target, upper) <= 0 : compareVersions(target, upper) < 0;
        if (lowerOk && upperOk) {
          return true;
        }
      }
    }

    return false;
  };

  const classifyVersionMatch = (versionTags = [], target) => {
    if (!target || !Array.isArray(versionTags) || versionTags.length === 0) {
      return null;
    }

  const normalizedTarget = normalizeVersionString(target);
  const targetParts = normalizedTarget.split('.');
  const [targetMajor, targetMinor] = targetParts;
  const targetHasPatch = targetParts.length > 2 && targetParts[2] !== undefined && targetParts[2] !== '';
  const targetPatchValue = targetHasPatch ? Number.parseInt(targetParts[2], 10) : NaN;
  const targetPatchIsPositive = Number.isFinite(targetPatchValue) && targetPatchValue > 0;
    const targetMajorMinor = targetMajor && targetMinor ? `${targetMajor}.${targetMinor}` : null;

    const tokens = [];
    versionTags.forEach(tag => {
      if (tag === null || tag === undefined) {
        return;
      }
      const normalizedTag = normalizeVersionString(tag);
      if (!normalizedTag) {
        return;
      }
      normalizedTag
        .split(/[,|]/)
        .map(token => token.trim())
        .filter(Boolean)
        .forEach(token => tokens.push(token));
    });

    for (const token of tokens) {
      if (token === normalizedTarget) {
        return 'exact';
      }

      if (targetMajorMinor) {
        if (token === targetMajorMinor) {
          if (!targetPatchIsPositive) {
          return 'majorMinor';
          }
          continue;
        }

        if ([`${targetMajorMinor}.x`, `${targetMajorMinor}.*`, `${targetMajorMinor}-x`, `${targetMajorMinor}_x`, `${targetMajorMinor}+`].includes(token)) {
          return 'wildcard';
        }

        if (!targetHasPatch && token.startsWith(`${targetMajorMinor}.`)) {
          const suffix = token.substring(targetMajorMinor.length + 1);
          if (/^\d+$/.test(suffix)) {
            return 'patch';
          }
        }
      }

      if (targetMajor && token === targetMajor) {
        if (targetParts.length === 1) {
        return 'major';
        }
        continue;
      }

      if (token.startsWith('~')) {
        const approx = token.substring(1);
        if (targetMajorMinor && approx.startsWith(targetMajorMinor)) {
          return 'approx';
        }
        if (targetMajor && approx.startsWith(targetMajor)) {
          return 'approx';
        }
      }

      if (satisfiesComparisonExpression(token, normalizedTarget)) {
        return 'range';
      }
    }

    return null;
  };

  // Filter versions that match our requirements
  const originalCount = versions.length;
  const normalizeLoaderValue = value => {
    if (!value) {
      return '';
    }
    const normalized = String(value).trim().toLowerCase();
    const loaderAliases = {
      'fabricloader': 'fabric',
      'fabric-loader': 'fabric',
      'fabric_api': 'fabric',
      'neo-forge': 'neoforge',
      'neo_forge': 'neoforge',
      'neo.forge': 'neoforge',
      'forge-loader': 'forge',
      'quilt-loader': 'quilt',
      'quiltloader': 'quilt',
      'liteloader': 'liteloader',
      'rift-loader': 'rift'
    };
    return loaderAliases[normalized] || normalized;
  };

  const effectiveLoader = normalizeLoaderValue(loader);

  let loaderFilteredVersions = versions;
  if (effectiveLoader) {
    loaderFilteredVersions = versions.filter(v => Array.isArray(v.loaders) && v.loaders.some(loaderCandidate => normalizeLoaderValue(loaderCandidate) === effectiveLoader));
  }

  if (effectiveLoader && loaderFilteredVersions.length === 0) {
    logger.debug('No versions matched requested loader', {
      category: 'mods',
      data: {
        service: 'ModApiService',
        operation: 'getModrinthVersions',
        traceId,
        projectId,
        requestedLoader: effectiveLoader,
        originalCount
      }
    });
  }

  let compatibleVersions = loaderFilteredVersions;
  let versionMatchType = 'any';
  const matchBuckets = {
    exact: [],
    patch: [],
    majorMinor: [],
    wildcard: [],
    range: [],
    approx: [],
    major: []
  };

  if (gameVersion) {
    loaderFilteredVersions.forEach(versionEntry => {
      const matchType = classifyVersionMatch(versionEntry.game_versions, targetVersionNormalized);
      if (matchType && matchBuckets[matchType]) {
        matchBuckets[matchType].push(versionEntry);
      } else if (matchType) {
        matchBuckets.range.push(versionEntry);
      }
    });

    const priorityOrder = ['exact', 'patch', 'majorMinor', 'wildcard', 'range', 'approx', 'major'];
    for (const priority of priorityOrder) {
      if (matchBuckets[priority] && matchBuckets[priority].length > 0) {
        compatibleVersions = matchBuckets[priority];
        versionMatchType = priority;
        break;
      }
    }

    if (versionMatchType === 'any' && loaderFilteredVersions.length > 0 && compatibleVersions === loaderFilteredVersions) {
      if (loadLatestOnly) {
        versionMatchType = 'fallback';
      } else {
        compatibleVersions = [];
        versionMatchType = 'none';
      }
    }

    if (compatibleVersions.length > 0) {
      const strictlyCompatibleVersions = compatibleVersions.filter(versionEntry =>
        Array.isArray(versionEntry.game_versions) &&
        versionEntry.game_versions.some(tag => doesVersionTagApply(tag, targetVersionNormalized))
      );

      if (strictlyCompatibleVersions.length !== compatibleVersions.length) {
        logger.debug('Strict compatibility filter removed ambiguous tags', {
          category: 'mods',
          data: {
            service: 'ModApiService',
            operation: 'getModrinthVersions',
            traceId,
            projectId,
            gameVersion,
            removedCount: compatibleVersions.length - strictlyCompatibleVersions.length
          }
        });
      }

      compatibleVersions = strictlyCompatibleVersions;

      if (compatibleVersions.length === 0) {
        versionMatchType = 'none';
      }
    }

    logger.debug('Game version filtering applied', {
      category: 'mods',
      data: {
        service: 'ModApiService',
        operation: 'getModrinthVersions',
        traceId,
        projectId,
        gameVersion,
        versionMatchType,
        matchCounts: Object.fromEntries(Object.entries(matchBuckets).map(([key, list]) => [key, list.length]))
      }
    });
  }

  logger.debug('Versions filtered for compatibility', {
    category: 'mods',
    data: {
      service: 'ModApiService',
      operation: 'getModrinthVersions',
      traceId,
      projectId,
      originalCount,
      loaderFilteredCount: loaderFilteredVersions.length,
      compatibleCount: compatibleVersions.length,
      loader: effectiveLoader || loader,
      gameVersion,
      filteredOut: originalCount - compatibleVersions.length,
      versionMatchType
    }
  });
    
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
  
  const versionsDuration = Date.now() - versionsStartTime;
  
  logger.info('Mod versions processed and cached', {
    category: 'mods',
    data: {
      service: 'ModApiService',
      operation: 'getModrinthVersions',
      duration: versionsDuration,
      projectId,
      versionsFound: mappedVersions.length,
      loadLatestOnly,
      cacheKey,
      cacheSize: versionCache.size,
      totalApiRequests: performanceMetrics.apiRequests
    }
  });
  
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
        const bTargetIndex = b.gameVersions.indexOf(gameVersion);
        return aTargetIndex - bTargetIndex; // lower index = earlier in list = primary target
      });
      
      logger.debug('Latest version selected with specificity sorting', {
        category: 'mods',
        data: {
          service: 'ModApiService',
          operation: 'getModrinthVersions',
          projectId,
          selectedVersion: sortedBySpecificity[0]?.versionNumber,
          isStable: sortedBySpecificity[0]?.isStable,
          gameVersions: sortedBySpecificity[0]?.gameVersions?.length
        }
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
  
  return await retryWithBackoff(async () => {
    const controller = new AbortController();
    const timeoutId = setTimeout(() => controller.abort(), 20000); // 10 second timeout
    
    try {
      const response = await fetch(`${MODRINTH_API}/version/${versionId}`, {
        signal: controller.signal
      });
      clearTimeout(timeoutId);

      if (!response.ok) {
        // Graceful fallback for 404 (version removed or invalid)
        if (response.status === 404 && projectId) {
          logger.warn('Version ID returned 404, falling back to latest version', {
            category: 'network',
            data: {
              function: 'getModrinthVersionInfo',
              projectId,
              missingVersionId: versionId,
              status: response.status,
              fallback: true
            }
          });
          try {
            const latest = await getLatestModrinthVersionInfo(projectId, gameVersion, loader);
            return { ...latest, _fallbackFrom404: true, originalVersionId: versionId };
          } catch (fallbackErr) {
            logger.error(`Fallback to latest version failed: ${fallbackErr.message}`, {
              category: 'network',
              data: {
                function: 'getModrinthVersionInfo',
                projectId,
                missingVersionId: versionId,
                errorType: fallbackErr.constructor.name
              }
            });
            throw new Error(`Modrinth version not found (404) and fallback failed: ${fallbackErr.message}`);
          }
        }
        throw new Error(`Modrinth API error: ${response.status}`);
      }

      return await response.json();
    } catch (error) {
      clearTimeout(timeoutId);
      if (error.name === 'AbortError') {
        throw new Error(`API timeout for version ${versionId} - network may be slow or API unavailable`);
      }
      throw error;
    }
  });
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
 * Lookup Modrinth version by file hash
 * Docs: GET /version_file/{hash}
 * Hash algorithm: sha1 (recommended), sha512 supported but we use sha1 here
 * @param {string} hashHex - file hash in hex
 * @param {'sha1'|'sha512'} algorithm
 * @returns {Promise<Object|null>} Version JSON or null if not found
 */
async function getModrinthVersionByFileHash(hashHex, algorithm = 'sha1') {
  if (!hashHex) return null;
  await rateLimit();
  return await retryWithBackoff(async () => {
    const controller = new AbortController();
    const timeoutId = setTimeout(() => controller.abort(), 20000);
    try {
      const response = await fetch(`${MODRINTH_API}/version_file/${hashHex}?algorithm=${algorithm}`, {
        signal: controller.signal
      });
      clearTimeout(timeoutId);
      if (response.status === 404) {
        return null;
      }
      if (!response.ok) {
        throw new Error(`Modrinth API error: ${response.status}`);
      }
      return await response.json();
    } catch (error) {
      clearTimeout(timeoutId);
      if (error.name === 'AbortError') {
        throw new Error(`API timeout for version_file ${algorithm}:${hashHex.substring(0,8)}...`);
      }
      throw error;
    }
  });
}

/**
 * Get popular mods from CurseForge
 * 
 * @param {Object} options - Search options
 * @param {string} options.loader - Mod loader (fabric, forge, etc.)
 * @param {string} options.version - Minecraft version
 * @param {number} options.page - Page number (1-based)
 * @param {number} options.limit - Results per page
 * @param {string} [options.environmentType='all'] - Filter by environment type ('all', 'client', 'server', 'both')
 * @returns {Promise<Object>} Object with mods array and pagination info
 */
async function getCurseForgePopular({ page = 1, limit = 20, environmentType = 'all' }) {
  void environmentType; // silence unused parameter warning
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
 * @param {string} [options.environmentType='all'] - Filter by environment type ('all', 'client', 'server', 'both')
 * @returns {Promise<Object>} Object with mods array and pagination info
 */
async function searchCurseForgeMods({ page = 1, limit = 20, environmentType = 'all' }) {
  void environmentType; // silence unused parameter warning
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
  filterModsByEnvironment,
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
  getModrinthVersionByFileHash,
  getCurseForgePopular,
  searchCurseForgeMods,
  getCurseForgeDownloadUrl
};
