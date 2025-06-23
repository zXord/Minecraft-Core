const fs = require('fs/promises');
const path = require('path');
const os = require('os');
const axios = require('axios');
const AdmZip = require('adm-zip');

// Simple global cache to prevent infinite loops
const metadataCache = new Map();
const cacheTimeout = 60000; // 1 minute cache

function invalidateMetadataCache(jarPath) {
  for (const key of Array.from(metadataCache.keys())) {
    if (key.startsWith(`${jarPath}-`)) {
      metadataCache.delete(key);
    }
  }
}

async function extractDependenciesFromJar(jarPath) {
  const cacheKey = `${jarPath}-${Date.now() - (Date.now() % cacheTimeout)}`;
  
  // Return cached result if available
  if (metadataCache.has(cacheKey)) {
    return metadataCache.get(cacheKey);
  }
  
  let result = null;
  
  try {
    try {
      await fs.access(jarPath);
    } catch {
      result = null;
      metadataCache.set(cacheKey, result);
      return result;
    }

    try {
      const zip = new (/** @type {any} */ (AdmZip))(jarPath);
      const zipEntries = zip.getEntries();

      // Try fabric.mod.json
      const fabricEntry = zipEntries.find(entry =>
        entry.entryName === 'fabric.mod.json' ||
        entry.entryName.endsWith('/fabric.mod.json')
      );

      if (fabricEntry) {
        const content = fabricEntry.getData().toString('utf8');
        try {
          const metadata = JSON.parse(content);
          metadata.loaderType = metadata.loaderType || 'fabric';
          metadata.projectId = metadata.projectId || metadata.id;
          metadata.authors = metadata.authors || (metadata.author ? [metadata.author] : (metadata.contributors ? Object.keys(metadata.contributors) : []));
          metadata.name = metadata.name || metadata.id;
          result = metadata;
          metadataCache.set(cacheKey, result);
          return result;
        } catch {
          result = null;
          metadataCache.set(cacheKey, result);
          return result;
        }
      }

      // Try META-INF/mods.toml (Forge)
      const forgeEntry = zipEntries.find(entry =>
        entry.entryName === 'META-INF/mods.toml' ||
        entry.entryName.endsWith('/META-INF/mods.toml')
      );

      if (forgeEntry) {
        const content = forgeEntry.getData().toString('utf8');
        try {
          const metadata = { loaderType: 'forge', authors: [], dependencies: [] };
          const lines = content.split(/\r?\n/);
          let currentModTable = {};
          let inModsArray = false;
          let inDescription = false;
          let currentDescription = [];

          lines.forEach(line => {
            line = line.trim();
            
            if (line === '[[mods]]') {
              if (Object.keys(currentModTable).length > 0) {
                Object.assign(metadata, currentModTable);
                currentModTable = {};
              }
              inModsArray = true;
              inDescription = false;
              return;
            }
            
            if (inModsArray && line.startsWith('[') && line !== '[[mods]]') {
              inModsArray = false;
              return;
            }
            
            if (line.startsWith('description="""') || line === 'description="""') {
              inDescription = true;
              currentDescription = [];
              if (line.length > 15) {
                currentDescription.push(line.substring(15));
              }
              return;
            }
            
            if (inDescription) {
              if (line.endsWith('"""') && line !== '"""') {
                currentDescription.push(line.substring(0, line.length - 3));
                if (inModsArray) {
                  currentModTable.description = currentDescription.join('\n');
                } else {
                  metadata.description = currentDescription.join('\n');
                }
                inDescription = false;
                return;
              } else if (line === '"""') {
                if (inModsArray) {
                  currentModTable.description = currentDescription.join('\n');
                } else {
                  metadata.description = currentDescription.join('\n');
                }
                inDescription = false;
                return;
              } else {
                currentDescription.push(line);
                return;
              }
            }
            
            const match = line.match(/^(\w+)\s*=\s*"([^"]*)"$/);
            if (match) {
              const [, key, value] = match;
              if (inModsArray) {
                currentModTable[key] = value;
              } else {
                metadata[key] = value;
              }
            }
          });
          
          if (Object.keys(currentModTable).length > 0) {
            Object.assign(metadata, currentModTable);
          }
          
          metadata.name = metadata.displayName || metadata.modId || 'Unknown';
          metadata.version = metadata.version || 'Unknown';
          metadata.projectId = metadata.modId || metadata.name;
          
          result = metadata;
          metadataCache.set(cacheKey, result);
          return result;
        } catch {
          result = null;
          metadataCache.set(cacheKey, result);
          return result;
        }
      }

      // Try quilt.mod.json
      const quiltEntry = zipEntries.find(entry =>
        entry.entryName === 'quilt.mod.json' ||
        entry.entryName.endsWith('/quilt.mod.json')
      );

      if (quiltEntry) {
        const content = quiltEntry.getData().toString('utf8');
        try {
          const quiltJson = JSON.parse(content);
          const qmd = quiltJson.quilt_loader || quiltJson;
          
          const metadata = {
            loaderType: 'quilt',
            id: qmd.id,
            version: qmd.version,
            name: (qmd.metadata && qmd.metadata.name) || qmd.id,
            description: (qmd.metadata && qmd.metadata.description) || '',
            authors: [],
            projectId: qmd.id
          };

          if (qmd.metadata && qmd.metadata.contributors) {
            metadata.authors = Object.keys(qmd.metadata.contributors);
          } else if (quiltJson.contributors) {
             metadata.authors = Object.keys(quiltJson.contributors);
          }

          result = metadata;
          metadataCache.set(cacheKey, result);
          return result;
        } catch {
          result = null;
          metadataCache.set(cacheKey, result);
          return result;
        }
      }
      
      result = null;
      metadataCache.set(cacheKey, result);
      return result;
    } catch {
      result = null;
      metadataCache.set(cacheKey, result);
      return result;
    }
  } catch (error) {
    console.error(`[ERROR] Failed to extract dependencies from ${jarPath}:`, error.message);
    result = null;
    metadataCache.set(cacheKey, result);
    return result;
  }
}

async function fetchModInfoFromUrl(url) {
  try {
    const tempFile = path.join(os.tmpdir(), `mod-${Date.now()}.jar`);
    
    try {
      const response = await axios({
        url: url,
        method: 'GET',
        responseType: 'arraybuffer'
      });
        
      await fs.writeFile(tempFile, response.data);
      
      const dependencies = await extractDependenciesFromJar(tempFile);
      try {
        await fs.unlink(tempFile);
      } catch {
        // Ignore cleanup errors
      }
      
      return dependencies;
    } catch (err) {
      try {
        await fs.unlink(tempFile);
      } catch {
        // Ignore cleanup errors
      }
      throw err;
    }  } catch {
    return [];
  }
}

async function analyzeModFromUrl(url, modId) {
  try {
    // Use fetchModInfoFromUrl to get the metadata
    const metadata = await fetchModInfoFromUrl(url);
    
    if (!metadata) {
      return { success: false, error: 'Could not extract metadata from mod file' };
    }
    
    // Return the analysis result
    return {
      success: true,
      metadata: {
        ...metadata,
        providedModId: modId, // Include the provided mod ID for reference
        analysisTimestamp: Date.now()
      }
    };
  } catch (error) {
    console.error(`[ERROR] Failed to analyze mod from URL ${url}:`, error.message);
    return { 
      success: false, 
      error: error.message || 'Failed to analyze mod from URL' 
    };
  }
}

module.exports = {
  extractDependenciesFromJar,
  fetchModInfoFromUrl,
  analyzeModFromUrl,
  invalidateMetadataCache
};
