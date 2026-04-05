const fs = require('fs/promises');
const path = require('path');
const os = require('os');
const axios = require('axios');
const AdmZip = require('adm-zip');
const { Worker } = require('worker_threads');

// Cache extracted metadata by file signature so unchanged jars do not get reparsed.
const metadataCache = new Map();
const metadataCacheKeyByPath = new Map();
const metadataWorkerPath = path.join(__dirname, 'mod-metadata-worker.cjs');

function buildMetadataCacheKey(jarPath, stats) {
  return `${jarPath}::${stats.size}::${Math.trunc(stats.mtimeMs)}`;
}

function updateMetadataCacheKey(jarPath, cacheKey) {
  const previousKey = metadataCacheKeyByPath.get(jarPath);
  if (previousKey && previousKey !== cacheKey) {
    metadataCache.delete(previousKey);
  }
  metadataCacheKeyByPath.set(jarPath, cacheKey);
}

function invalidateMetadataCache(jarPath) {
  const previousKey = metadataCacheKeyByPath.get(jarPath);
  if (previousKey) {
    metadataCache.delete(previousKey);
    metadataCacheKeyByPath.delete(jarPath);
    return;
  }

  for (const key of Array.from(metadataCache.keys())) {
    if (key.startsWith(`${jarPath}::`)) {
      metadataCache.delete(key);
    }
  }
}

function parseJarMetadataSync(jarPath) {
  let result = null;

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
        return metadata;
      } catch {
        return null;
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
        
        return metadata;
      } catch {
        return null;
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
        
        return {
          loaderType: 'quilt',
          id: qmd.id,
          version: qmd.version,
          name: (qmd.metadata && qmd.metadata.name) || qmd.id,
          description: (qmd.metadata && qmd.metadata.description) || '',
          authors: qmd.metadata && qmd.metadata.contributors
            ? Object.keys(qmd.metadata.contributors)
            : (quiltJson.contributors ? Object.keys(quiltJson.contributors) : []),
          projectId: qmd.id
        };
      } catch {
        return null;
      }
    }

    return null;
  } catch {
    return null;
  }
}

function extractMetadataWithWorker(jarPath) {
  return new Promise((resolve) => {
    let settled = false;
    let worker = null;

    const finish = (value) => {
      if (settled) return;
      settled = true;
      if (worker) {
        worker.removeAllListeners();
        worker.terminate().catch(() => {});
      }
      resolve(value);
    };

    try {
      worker = new Worker(metadataWorkerPath, {
        workerData: { jarPath }
      });

      worker.once('message', (message) => {
        finish(message?.metadata ?? null);
      });

      worker.once('error', () => {
        finish(parseJarMetadataSync(jarPath));
      });

      worker.once('exit', (code) => {
        if (!settled) {
          finish(code === 0 ? null : parseJarMetadataSync(jarPath));
        }
      });
    } catch {
      finish(parseJarMetadataSync(jarPath));
    }
  });
}

async function extractDependenciesFromJar(jarPath) {
  try {
    const stats = await fs.stat(jarPath);
    const cacheKey = buildMetadataCacheKey(jarPath, stats);
    updateMetadataCacheKey(jarPath, cacheKey);

    if (metadataCache.has(cacheKey)) {
      return metadataCache.get(cacheKey);
    }

    const extractionPromise = extractMetadataWithWorker(jarPath)
      .then((metadata) => {
        const resolvedMetadata = metadata ?? null;
        metadataCache.set(cacheKey, resolvedMetadata);
        return resolvedMetadata;
      })
      .catch(() => {
        metadataCache.set(cacheKey, null);
        return null;
      });

    metadataCache.set(cacheKey, extractionPromise);
    return extractionPromise;
  } catch {
    invalidateMetadataCache(jarPath);
    return null;
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
    // TODO: Add proper logging - Failed to analyze mod from URL ${url}:
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
  invalidateMetadataCache,
  parseJarMetadataSync
};
