/**
 * Utility functions for interacting with mod APIs (Modrinth and CurseForge)
 */

// Modrinth API base URL
const MODRINTH_API = 'https://api.modrinth.com/v2';

// CurseForge API base URL and key
const CURSEFORGE_API = 'https://api.curseforge.com/v1';
// This is a public API key for demo purposes - in production, you'd want to use environment variables
const CF_API_KEY = '$2a$10$6h9Ca8GTUGBZp7/X3TVTC.9tLCIg5.ry0O0L7NQxDo2Lj0dGPm2HO';

/**
 * Fetch with retry mechanism for handling rate limits
 * @param {string} url - URL to fetch
 * @param {Object} options - Fetch options
 * @param {number} maxRetries - Maximum number of retries
 * @param {number} initialDelay - Initial delay in ms
 * @returns {Promise<Response>} Fetch response
 */
async function fetchWithRetry(url, options = {}, maxRetries = 3, initialDelay = 1000) {
  if (!url) {
    throw new Error('URL is required for API request');
  }
  
  let lastError;
  let delay = initialDelay;
  
  for (let attempt = 0; attempt <= maxRetries; attempt++) {
    try {
      const response = await fetch(url, options);
      
      // If we hit a rate limit (429), wait and retry
      if (response.status === 429) {
        if (attempt === maxRetries) {
          throw new Error(`Rate limit exceeded after ${maxRetries} retries. Try again later.`);
        }
        
        // Get retry-after header if available or use exponential backoff
        const retryAfter = response.headers.get('retry-after');
        const waitTime = retryAfter ? parseInt(retryAfter) * 1000 : delay;
        
        await new Promise(resolve => setTimeout(resolve, waitTime));
        
        // Increase delay for next attempt (exponential backoff)
        delay *= 2;
        continue;
      }
      
      return response;
    } catch (error) {
      lastError = error;
      
      if (attempt === maxRetries) {
        throw error;
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
  
  try {
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

    const response = await fetchWithRetry(`${MODRINTH_API}/search?${params.toString()}`);
    
    if (!response.ok) {
      throw new Error(`Modrinth API error: ${response.status}`);
    }
    
    const data = await response.json();
    return data.hits.map(mod => ({
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
  } catch (error) {
    throw error;
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
  
  if (!query) {
    return [];
  }
  
  try {
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

    const response = await fetchWithRetry(`${MODRINTH_API}/search?${params.toString()}`);
    
    if (!response.ok) {
      throw new Error(`Modrinth API error: ${response.status}`);
    }
    
    const data = await response.json();
    return data.hits.map(mod => ({
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
  } catch (error) {
    throw error;
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
  if (!projectId) {
    throw new Error('Project ID is required');
  }
  
  try {
    const response = await fetchWithRetry(`${MODRINTH_API}/project/${projectId}/version`);
    
    if (!response.ok) {
      throw new Error(`Modrinth API error: ${response.status}`);
    }
    
    const versions = await response.json();
    
    // Filter versions that match our requirements
    const matchingVersions = versions.filter(v => {
      return (
        (!version || v.game_versions.includes(version)) &&
        (!loader || v.loaders.includes(loader))
      );
    });
    
    if (matchingVersions.length === 0) {
      throw new Error('No matching versions found for this mod');
    }
    
    // Get latest version
    const latest = matchingVersions[0];
    
    // Get primary file
    if (latest.files.length === 0) {
      throw new Error('No files found for this mod version');
    }
    
    const primaryFile = latest.files.find(file => file.primary) || latest.files[0];
    return primaryFile.url;
  } catch (error) {
    throw error;
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
    
    const response = await fetch(`${CURSEFORGE_API}/mods/search?${params.toString()}`, {
      headers: {
        'x-api-key': CF_API_KEY,
      },
    });
    
    if (!response.ok) {
      throw new Error(`CurseForge API error: ${response.status}`);
    }
    
    const data = await response.json();
    return data.data.map(mod => ({
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
  } catch (error) {
    
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
    
    const response = await fetch(`${CURSEFORGE_API}/mods/search?${params.toString()}`, {
      headers: {
        'x-api-key': CF_API_KEY,
      },
    });
    
    if (!response.ok) {
      throw new Error(`CurseForge API error: ${response.status}`);
    }
    
    const data = await response.json();
    return data.data.map(mod => ({
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
  } catch (error) {
    
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
  try {
    const modLoaderId = loader === 'fabric' ? 4 : loader === 'forge' ? 1 : null;
    
    const response = await fetch(`${CURSEFORGE_API}/mods/${modId}`, {
      headers: {
        'x-api-key': CF_API_KEY,
      },
    });
    
    if (!response.ok) {
      throw new Error(`CurseForge API error: ${response.status}`);
    }
    
    const data = await response.json();
    const files = data.data.latestFiles;
    
    // Filter files that match our requirements
    const matchingFiles = files.filter(file => {
      return (
        (!version || file.gameVersions.includes(version)) &&
        (!modLoaderId || file.modLoaderType === modLoaderId)
      );
    });
    
    if (matchingFiles.length === 0) {
      throw new Error('No matching files found for this mod');
    }
    
    // Get latest file
    const latest = matchingFiles[0];
    return latest.downloadUrl;
  } catch (error) {
    throw error;
  }
} 