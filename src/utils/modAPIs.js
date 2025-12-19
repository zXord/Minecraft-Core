/**
 * Utility functions for interacting with mod APIs (Modrinth and CurseForge)
 */
import logger from './logger.js';

// Modrinth API base URL
const MODRINTH_API = 'https://api.modrinth.com/v2';

// CurseForge API base URL and key
const CURSEFORGE_API = 'https://api.curseforge.com/v1';
const CF_API_KEY = '';

/**
 * Fetch with retry mechanism for handling rate limits
 * @param {string} url - URL to fetch
 * @param {Object} options - Fetch options
 * @param {number} maxRetries - Maximum number of retries
 * @param {number} initialDelay - Initial delay in ms
 * @returns {Promise<Response>} Fetch response
 */
async function fetchWithRetry(url, options = {}, maxRetries = 3, initialDelay = 1000) {
  logger.debug('Starting API request with retry mechanism', {
    category: 'utils',
    data: {
      function: 'fetchWithRetry',
      url,
      maxRetries,
      initialDelay,
      hasUrl: !!url
    }
  });
  
  if (!url) {
    const error = new Error('URL is required for API request');
    logger.error('No URL provided to fetchWithRetry', {
      category: 'utils',
      data: {
        function: 'fetchWithRetry',
        url,
        errorMessage: error.message
      }
    });
    throw error;
  }
  
  let lastError;
  let delay = initialDelay;
  
  for (let attempt = 0; attempt <= maxRetries; attempt++) {
    try {
      logger.debug('Making API request attempt', {
        category: 'utils',
        data: {
          function: 'fetchWithRetry',
          url,
          attempt: attempt + 1,
          maxRetries: maxRetries + 1,
          delay
        }
      });
      
      const response = await fetch(url, options);
      
      // If we hit a rate limit (429), wait and retry
      if (response.status === 429) {
        if (attempt === maxRetries) {
          const error = new Error(`Rate limit exceeded after ${maxRetries} retries. Try again later.`);
          logger.error('Rate limit exceeded - no more retries', {
            category: 'utils',
            data: {
              function: 'fetchWithRetry',
              url,
              attempt: attempt + 1,
              status: response.status,
              errorMessage: error.message
            }
          });
          throw error;
        }
        
        // Get retry-after header if available or use exponential backoff
        const retryAfter = response.headers.get('retry-after');
        const waitTime = retryAfter ? parseInt(retryAfter) * 1000 : delay;
        
        logger.warn('Rate limit hit - waiting before retry', {
          category: 'utils',
          data: {
            function: 'fetchWithRetry',
            url,
            attempt: attempt + 1,
            status: response.status,
            retryAfter,
            waitTime,
            nextDelay: delay * 2
          }
        });
        
        await new Promise(resolve => setTimeout(resolve, waitTime));
        
        // Increase delay for next attempt (exponential backoff)
        delay *= 2;
        continue;
      }
      
      logger.debug('API request successful', {
        category: 'utils',
        data: {
          function: 'fetchWithRetry',
          url,
          attempt: attempt + 1,
          status: response.status,
          ok: response.ok
        }
      });
      
      return response;
    } catch (err) {
      lastError = err;
      
      logger.warn('API request attempt failed', {
        category: 'utils',
        data: {
          function: 'fetchWithRetry',
          url,
          attempt: attempt + 1,
          errorMessage: err.message,
          isLastAttempt: attempt === maxRetries
        }
      });
      
      if (attempt === maxRetries) {
        logger.error('All API request attempts failed', {
          category: 'utils',
          data: {
            function: 'fetchWithRetry',
            url,
            totalAttempts: attempt + 1,
            finalError: err.message
          }
        });
        throw err;
      }
      
      // Wait before retrying
      await new Promise(resolve => setTimeout(resolve, delay));
      delay *= 2; // Exponential backoff
    }
  }
  
  throw lastError;
}

/**
 * Get popular mods from Modrinth
 * 
 * @param {Object} options - Search options
 * @param {string} [options.loader] - Mod loader (fabric, forge, etc.)
 * @param {string} [options.version] - Minecraft version
 * @returns {Promise<Array>} Array of mod objects
 */
export async function getModrinthPopular(options = {}) {
  const { loader, version } = options;
  
  logger.info('Fetching popular mods from Modrinth', {
    category: 'utils',
    data: {
      function: 'getModrinthPopular',
      loader,
      version,
      apiUrl: MODRINTH_API
    }
  });
  
  const params = new URLSearchParams({
    limit: '20',
    offset: '0',
    facets: JSON.stringify([
      ['categories:forge', 'categories:fabric', 'categories:quilt'].includes(`categories:${loader}`) 
        ? [`categories:${loader}`] 
        : [],
      version ? [`versions:${version}`] : [],
    ].filter(facet => facet.length > 0))
  });

  try {
    const response = await fetchWithRetry(`${MODRINTH_API}/search?${params.toString()}`);
    
    if (!response.ok) {
      const error = new Error(`Modrinth API error: ${response.status}`);
      logger.error('Modrinth API returned error status', {
        category: 'utils',
        data: {
          function: 'getModrinthPopular',
          status: response.status,
          statusText: response.statusText,
          loader,
          version
        }
      });
      throw error;
    }
    
    const data = await response.json();
    const mods = data.hits.map(mod => ({
      id: mod.project_id,
      name: mod.title,
      description: mod.description,
      author: mod.author,
      downloads: mod.downloads,
      versions: mod.versions,
      iconUrl: mod.icon_url,
      source: 'modrinth',
      downloadUrl: mod.project_id, // We'll need the project ID to get the correct download URL later
      clientSide: mod.client_side === 'required' ? true : mod.client_side === 'optional',
      serverSide: mod.server_side === 'required' ? true : mod.server_side === 'optional'
    }));
    
    logger.info('Popular mods fetched successfully from Modrinth', {
      category: 'utils',
      data: {
        function: 'getModrinthPopular',
        loader,
        version,
        modsCount: mods.length
      }
    });
    
    return mods;
  } catch (err) {
    logger.error('Error fetching popular mods from Modrinth', {
      category: 'utils',
      data: {
        function: 'getModrinthPopular',
        loader,
        version,
        errorMessage: err.message
      }
    });
    throw err;
  }
}

/**
 * Search for mods on Modrinth
 * 
 * @param {Object} options - Search options
 * @param {string} [options.query] - Search query
 * @param {string} [options.loader] - Mod loader (fabric, forge, etc.)
 * @param {string} [options.version] - Minecraft version
 * @returns {Promise<Array>} Array of mod objects
 */
export async function searchModrinthMods(options = {}) {
  const { query, loader, version } = options;
  
  logger.info('Searching mods on Modrinth', {
    category: 'utils',
    data: {
      function: 'searchModrinthMods',
      query,
      loader,
      version,
      hasQuery: !!query
    }
  });
  
  if (!query) {
    logger.debug('No search query provided - returning empty results', {
      category: 'utils',
      data: {
        function: 'searchModrinthMods',
        query,
        loader,
        version
      }
    });
    return [];
  }
  
  const params = new URLSearchParams({
    query,
    limit: '20',
    offset: '0',
    facets: JSON.stringify([
      ['categories:forge', 'categories:fabric', 'categories:quilt'].includes(`categories:${loader}`) 
        ? [`categories:${loader}`] 
        : [],
      version ? [`versions:${version}`] : [],
    ].filter(facet => facet.length > 0))
  });

  try {
    const response = await fetchWithRetry(`${MODRINTH_API}/search?${params.toString()}`);
    
    if (!response.ok) {
      const error = new Error(`Modrinth API error: ${response.status}`);
      logger.error('Modrinth search API returned error status', {
        category: 'utils',
        data: {
          function: 'searchModrinthMods',
          query,
          loader,
          version,
          status: response.status,
          statusText: response.statusText
        }
      });
      throw error;
    }
    
    const data = await response.json();
    const mods = data.hits.map(mod => ({
      id: mod.project_id,
      name: mod.title,
      description: mod.description,
      author: mod.author,
      downloads: mod.downloads,
      versions: mod.versions,
      iconUrl: mod.icon_url,
      source: 'modrinth',
      downloadUrl: mod.project_id, // We'll need the project ID to get the correct download URL later
      clientSide: mod.client_side === 'required' ? true : mod.client_side === 'optional',
      serverSide: mod.server_side === 'required' ? true : mod.server_side === 'optional'
    }));
    
    logger.info('Modrinth search completed successfully', {
      category: 'utils',
      data: {
        function: 'searchModrinthMods',
        query,
        loader,
        version,
        modsFound: mods.length
      }
    });
    
    return mods;
  } catch (err) {
    logger.error('Error searching mods on Modrinth', {
      category: 'utils',
      data: {
        function: 'searchModrinthMods',
        query,
        loader,
        version,
        errorMessage: err.message
      }
    });
    throw err;
  }
}

/**
 * Get download URL for a Modrinth mod
 * 
 * @param {string} projectId - Modrinth project ID
 * @param {string} version - Minecraft version
 * @param {string} loader - Mod loader (fabric, forge, etc.)
 * @returns {Promise<string>} Download URL
 */
export async function getModrinthDownloadUrl(projectId, version, loader) {
  logger.info('Getting Modrinth download URL', {
    category: 'utils',
    data: {
      function: 'getModrinthDownloadUrl',
      projectId,
      version,
      loader,
      hasProjectId: !!projectId
    }
  });
  
  if (!projectId) {
    const error = new Error('Project ID is required');
    logger.error('No project ID provided to getModrinthDownloadUrl', {
      category: 'utils',
      data: {
        function: 'getModrinthDownloadUrl',
        projectId,
        version,
        loader,
        errorMessage: error.message
      }
    });
    throw error;
  }
  
  try {
    const response = await fetchWithRetry(`${MODRINTH_API}/project/${projectId}/version`);
    
    if (!response.ok) {
      const error = new Error(`Modrinth API error: ${response.status}`);
      logger.error('Modrinth versions API returned error status', {
        category: 'utils',
        data: {
          function: 'getModrinthDownloadUrl',
          projectId,
          version,
          loader,
          status: response.status,
          statusText: response.statusText
        }
      });
      throw error;
    }
    
    const versions = await response.json();
    
    logger.debug('Retrieved mod versions from Modrinth', {
      category: 'utils',
      data: {
        function: 'getModrinthDownloadUrl',
        projectId,
        version,
        loader,
        totalVersions: versions.length
      }
    });
    
    // Filter versions that match our requirements
    const matchingVersions = versions.filter(v => {
      return (
        (!version || v.game_versions.includes(version)) &&
        (!loader || v.loaders.includes(loader))
      );
    });
    
    if (matchingVersions.length === 0) {
      const error = new Error('No matching versions found for this mod');
      logger.error('No matching versions found for mod', {
        category: 'utils',
        data: {
          function: 'getModrinthDownloadUrl',
          projectId,
          version,
          loader,
          totalVersions: versions.length,
          matchingVersions: 0,
          errorMessage: error.message
        }
      });
      throw error;
    }
    
    // Get latest version
    const latest = matchingVersions[0];
    
    logger.debug('Found matching version for mod', {
      category: 'utils',
      data: {
        function: 'getModrinthDownloadUrl',
        projectId,
        version,
        loader,
        matchingVersionsCount: matchingVersions.length,
        selectedVersion: latest.version_number,
        filesCount: latest.files.length
      }
    });
    
    // Get primary file
    if (latest.files.length === 0) {
      const error = new Error('No files found for this mod version');
      logger.error('No files found for mod version', {
        category: 'utils',
        data: {
          function: 'getModrinthDownloadUrl',
          projectId,
          version,
          loader,
          modVersion: latest.version_number,
          errorMessage: error.message
        }
      });
      throw error;
    }
    
    const primaryFile = latest.files.find(file => file.primary) || latest.files[0];
    
    logger.info('Modrinth download URL retrieved successfully', {
      category: 'utils',
      data: {
        function: 'getModrinthDownloadUrl',
        projectId,
        version,
        loader,
        modVersion: latest.version_number,
        fileName: primaryFile.filename,
        fileSize: primaryFile.size
      }
    });
    
    return primaryFile.url;
  } catch (err) {
    logger.error('Error getting Modrinth download URL', {
      category: 'utils',
      data: {
        function: 'getModrinthDownloadUrl',
        projectId,
        version,
        loader,
        errorMessage: err.message
      }
    });
    throw err;
  }
}

/**
 * Get popular mods from CurseForge
 * 
 * @param {Object} options - Search options
 * @param {string} options.loader - Mod loader (fabric, forge, etc.)
 * @param {string} options.version - Minecraft version
 * @returns {Promise<Array>} Array of mod objects
 */
export async function getCurseForgePopular({ loader, version }) {
  if (!CF_API_KEY) {
    logger.warn('CurseForge API key not configured - skipping popular mods fetch', {
      category: 'utils',
      data: { function: 'getCurseForgePopular' }
    });
    return [];
  }

  logger.info('Fetching popular mods from CurseForge', {
    category: 'utils',
    data: {
      function: 'getCurseForgePopular',
      loader,
      version,
      apiUrl: CURSEFORGE_API
    }
  });
  
  try {
    const modLoaderId = loader === 'fabric' ? 4 : loader === 'forge' ? 1 : null;
    
    const params = new URLSearchParams({
      gameId: '432', // Minecraft game ID
      classId: '6', // Mods class ID
      pageSize: '20',
      sortField: '2', // Sort by popularity
      sortOrder: 'desc',
      modLoaderType: modLoaderId !== null ? modLoaderId.toString() : '',
      gameVersion: version || '',
    });
    
    logger.debug('Making CurseForge API request', {
      category: 'utils',
      data: {
        function: 'getCurseForgePopular',
        loader,
        version,
        modLoaderId,
        apiEndpoint: `${CURSEFORGE_API}/mods/search`
      }
    });
    
    const response = await fetch(`${CURSEFORGE_API}/mods/search?${params.toString()}`, {
      headers: {
        'x-api-key': CF_API_KEY,
      },
    });
    
    if (!response.ok) {
      const error = new Error(`CurseForge API error: ${response.status}`);
      logger.error('CurseForge API returned error status', {
        category: 'utils',
        data: {
          function: 'getCurseForgePopular',
          loader,
          version,
          status: response.status,
          statusText: response.statusText
        }
      });
      throw error;
    }
    
    const data = await response.json();
    const mods = data.data.map(mod => ({
      id: mod.id,
      name: mod.name,
      description: mod.summary,
      author: mod.authors[0]?.name || 'Unknown',
      downloads: mod.downloadCount,
      versions: mod.latestFiles.map(file => file.gameVersion),
      iconUrl: mod.logo?.thumbnailUrl,
      source: 'curseforge',
      downloadUrl: mod.id, // We'll need the mod ID to get the correct download URL later
    }));
    
    logger.info('Popular mods fetched successfully from CurseForge', {
      category: 'utils',
      data: {
        function: 'getCurseForgePopular',
        loader,
        version,
        modsCount: mods.length
      }
    });
    
    return mods;
  } catch (err) {
    logger.warn('Failed to fetch popular mods from CurseForge - returning empty array', {
      category: 'utils',
      data: {
        function: 'getCurseForgePopular',
        loader,
        version,
        errorMessage: err.message,
        fallbackBehavior: 'empty_array'
      }
    });
    // Return an empty array rather than throwing, since CurseForge might be behind a paywall
    return [];
  }
}

/**
 * Search for mods on CurseForge
 * 
 * @param {Object} options - Search options
 * @param {string} options.query - Search query
 * @param {string} options.loader - Mod loader (fabric, forge, etc.)
 * @param {string} options.version - Minecraft version
 * @returns {Promise<Array>} Array of mod objects
 */
export async function searchCurseForgeMods({ query, loader, version }) {
  if (!CF_API_KEY) {
    logger.warn('CurseForge API key not configured - skipping search', {
      category: 'utils',
      data: { function: 'searchCurseForgeMods' }
    });
    return [];
  }

  logger.info('Searching mods on CurseForge', {
    category: 'utils',
    data: {
      function: 'searchCurseForgeMods',
      query,
      loader,
      version,
      hasQuery: !!query
    }
  });
  
  try {
    const modLoaderId = loader === 'fabric' ? 4 : loader === 'forge' ? 1 : null;
    
    const params = new URLSearchParams({
      gameId: '432', // Minecraft game ID
      classId: '6', // Mods class ID
      searchFilter: query,
      pageSize: '20',
      modLoaderType: modLoaderId !== null ? modLoaderId.toString() : '',
      gameVersion: version || '',
    });
    
    logger.debug('Making CurseForge search API request', {
      category: 'utils',
      data: {
        function: 'searchCurseForgeMods',
        query,
        loader,
        version,
        modLoaderId,
        apiEndpoint: `${CURSEFORGE_API}/mods/search`
      }
    });
    
    const response = await fetch(`${CURSEFORGE_API}/mods/search?${params.toString()}`, {
      headers: {
        'x-api-key': CF_API_KEY,
      },
    });
    
    if (!response.ok) {
      const error = new Error(`CurseForge API error: ${response.status}`);
      logger.error('CurseForge search API returned error status', {
        category: 'utils',
        data: {
          function: 'searchCurseForgeMods',
          query,
          loader,
          version,
          status: response.status,
          statusText: response.statusText
        }
      });
      throw error;
    }
    
    const data = await response.json();
    const mods = data.data.map(mod => ({
      id: mod.id,
      name: mod.name,
      description: mod.summary,
      author: mod.authors[0]?.name || 'Unknown',
      downloads: mod.downloadCount,
      versions: mod.latestFiles.map(file => file.gameVersion),
      iconUrl: mod.logo?.thumbnailUrl,
      source: 'curseforge',
      downloadUrl: mod.id, // We'll need the mod ID to get the correct download URL later
    }));
    
    logger.info('CurseForge search completed successfully', {
      category: 'utils',
      data: {
        function: 'searchCurseForgeMods',
        query,
        loader,
        version,
        modsFound: mods.length
      }
    });
    
    return mods;
  } catch (err) {
    logger.warn('Failed to search mods on CurseForge - returning empty array', {
      category: 'utils',
      data: {
        function: 'searchCurseForgeMods',
        query,
        loader,
        version,
        errorMessage: err.message,
        fallbackBehavior: 'empty_array'
      }
    });
    // Return an empty array rather than throwing, since CurseForge might be behind a paywall
    return [];
  }
}

/**
 * Get download URL for a CurseForge mod
 * 
 * @param {string} modId - CurseForge mod ID
 * @param {string} version - Minecraft version
 * @param {string} loader - Mod loader (fabric, forge, etc.)
 * @returns {Promise<string>} Download URL
 */
export async function getCurseForgeDownloadUrl(modId, version, loader) {
  if (!CF_API_KEY) {
    const error = new Error('CurseForge API key not configured');
    logger.warn('CurseForge download requested without API key', {
      category: 'utils',
      data: { function: 'getCurseForgeDownloadUrl' }
    });
    throw error;
  }

  logger.info('Getting CurseForge download URL', {
    category: 'utils',
    data: {
      function: 'getCurseForgeDownloadUrl',
      modId,
      version,
      loader,
      hasModId: !!modId
    }
  });
  
  try {
    const modLoaderId = loader === 'fabric' ? 4 : loader === 'forge' ? 1 : null;
    
    const response = await fetch(`${CURSEFORGE_API}/mods/${modId}`, {
      headers: {
        'x-api-key': CF_API_KEY,
      },
    });
    
    if (!response.ok) {
      const error = new Error(`CurseForge API error: ${response.status}`);
      logger.error('CurseForge mod details API returned error status', {
        category: 'utils',
        data: {
          function: 'getCurseForgeDownloadUrl',
          modId,
          version,
          loader,
          status: response.status,
          statusText: response.statusText
        }
      });
      throw error;
    }
    
    const data = await response.json();
    const files = data.data.latestFiles;
    
    logger.debug('Retrieved mod files from CurseForge', {
      category: 'utils',
      data: {
        function: 'getCurseForgeDownloadUrl',
        modId,
        version,
        loader,
        modLoaderId,
        totalFiles: files.length
      }
    });
    
    // Filter files that match our requirements
    const matchingFiles = files.filter(file => {
      return (
        (!version || file.gameVersions.includes(version)) &&
        (!modLoaderId || file.modLoaderType === modLoaderId)
      );
    });
    
    if (matchingFiles.length === 0) {
      const error = new Error('No matching files found for this mod');
      logger.error('No matching files found for CurseForge mod', {
        category: 'utils',
        data: {
          function: 'getCurseForgeDownloadUrl',
          modId,
          version,
          loader,
          modLoaderId,
          totalFiles: files.length,
          matchingFiles: 0,
          errorMessage: error.message
        }
      });
      throw error;
    }
    
    // Get latest file
    const latest = matchingFiles[0];
    
    logger.info('CurseForge download URL retrieved successfully', {
      category: 'utils',
      data: {
        function: 'getCurseForgeDownloadUrl',
        modId,
        version,
        loader,
        matchingFilesCount: matchingFiles.length,
        fileName: latest.fileName,
        fileSize: latest.fileLength
      }
    });
    
    return latest.downloadUrl;
  } catch (err) {
    logger.error('Error getting CurseForge download URL', {
      category: 'utils',
      data: {
        function: 'getCurseForgeDownloadUrl',
        modId,
        version,
        loader,
        errorMessage: err.message
      }
    });
    throw err;
  }
}
