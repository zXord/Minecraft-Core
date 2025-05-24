const fs = require('fs/promises');
const path = require('path');
const os = require('os');
const axios = require('axios');
const AdmZip = require('adm-zip');

async function extractDependenciesFromJar(jarPath) {
  try {
    console.log(`[ModAnalysis] Analyzing mod file for dependencies: ${jarPath}`);
    
    try {
      await fs.access(jarPath);
    } catch (err) {
      throw new Error(`Mod file does not exist: ${jarPath}`);
    }
    
    try {
      const zip = new AdmZip(jarPath);
      const zipEntries = zip.getEntries();
      
      const fabricEntry = zipEntries.find(entry => 
        entry.entryName === 'fabric.mod.json' || 
        entry.entryName.endsWith('/fabric.mod.json')
      );
      
      if (fabricEntry) {
        console.log('[ModAnalysis] Found fabric.mod.json');
        const content = fabricEntry.getData().toString('utf8');
        try {
          const metadata = JSON.parse(content);
          const dependencies = [];
          if (metadata.depends && typeof metadata.depends === 'object') {
            Object.keys(metadata.depends).forEach(depId => {
              dependencies.push({
                id: depId,
                dependency_type: 'required',
                version_requirement: metadata.depends[depId]
              });
            });
          }
          if (metadata.recommends && typeof metadata.recommends === 'object') {
            Object.keys(metadata.recommends).forEach(depId => {
              dependencies.push({
                id: depId,
                dependency_type: 'optional',
                version_requirement: metadata.recommends[depId]
              });
            });
          }
          console.log(`[ModAnalysis] Extracted ${dependencies.length} dependencies from fabric.mod.json`);
          return dependencies;
        } catch (parseErr) {
          console.error('[ModAnalysis] Error parsing fabric.mod.json:', parseErr);
        }
      }
      
      const forgeEntry = zipEntries.find(entry => 
        entry.entryName === 'META-INF/mods.toml' || 
        entry.entryName.endsWith('/META-INF/mods.toml')
      );
      
      if (forgeEntry) {
        console.log('[ModAnalysis] Found Forge mods.toml');
        const content = forgeEntry.getData().toString('utf8');
        const dependencies = [];
        const dependencyLines = content.match(/\[\[dependencies\.[^\]]+\]\]([\s\S]*?)(?=\[|\Z)/g);
        
        if (dependencyLines) {
          dependencyLines.forEach(section => {
            const modIdMatch = section.match(/modId\s*=\s*["']([^"']+)["']/);
            if (modIdMatch) {
              const modId = modIdMatch[1];
              const mandatoryMatch = section.match(/mandatory\s*=\s*(true|false)/);
              const isMandatory = mandatoryMatch ? mandatoryMatch[1] === 'true' : false;
              const versionRangeMatch = section.match(/versionRange\s*=\s*["']([^"']+)["']/);
              const versionRange = versionRangeMatch ? versionRangeMatch[1] : '*';
              dependencies.push({
                id: modId,
                dependency_type: isMandatory ? 'required' : 'optional',
                version_requirement: versionRange
              });
            }
          });
        }
        console.log(`[ModAnalysis] Extracted ${dependencies.length} dependencies from mods.toml`);
        return dependencies;
      }
      
      const quiltEntry = zipEntries.find(entry => 
        entry.entryName === 'quilt.mod.json' || 
        entry.entryName.endsWith('/quilt.mod.json')
      );
      
      if (quiltEntry) {
        console.log('[ModAnalysis] Found quilt.mod.json');
        const content = quiltEntry.getData().toString('utf8');
        try {
          const metadata = JSON.parse(content);
          const dependencies = [];
          if (metadata.depends && Array.isArray(metadata.depends)) {
            metadata.depends.forEach(dep => {
              if (typeof dep === 'string') {
                dependencies.push({ id: dep, dependency_type: 'required' });
              } else if (dep && dep.id) {
                dependencies.push({
                  id: dep.id,
                  dependency_type: 'required',
                  version_requirement: dep.versions || dep.version
                });
              }
            });
          }
          console.log(`[ModAnalysis] Extracted ${dependencies.length} dependencies from quilt.mod.json`);
          return dependencies;
        } catch (parseErr) {
          console.error('[ModAnalysis] Error parsing quilt.mod.json:', parseErr);
        }
      }
      
      console.log('[ModAnalysis] No recognized mod metadata found in JAR');
      return [];
    } catch (zipErr) {
      console.error('[ModAnalysis] Error processing JAR file:', zipErr);
      return [];
    }
  } catch (error) {
    console.error('[ModAnalysis] Failed to extract dependencies from JAR:', error);
    return [];
  }
}

async function analyzeModFromUrl(url, modId) {
  try {
    console.log(`[ModAnalysis] Downloading and analyzing mod from URL: ${url}`);
    if (!url) throw new Error('URL is required for mod analysis');
    
    const tempDir = path.join(os.tmpdir(), 'minecraft-core-temp-analysis');
    await fs.mkdir(tempDir, { recursive: true });
    const tempFile = path.join(tempDir, `temp-analysis-${modId || Date.now()}.jar`);
    
    try {
      const response = await axios({
        url: url,
        method: 'GET',
        responseType: 'arraybuffer' // Changed to arraybuffer for direct writing
      });
      
      await fs.writeFile(tempFile, response.data);
      
      // Now call the local extractDependenciesFromJar
      const dependencies = await extractDependenciesFromJar(tempFile);
      
      try {
        await fs.unlink(tempFile);
      } catch (cleanupErr) {
        console.warn(`[ModAnalysis] Error cleaning up temporary file: ${cleanupErr.message}`);
      }
      
      return dependencies;
    } catch (err) {
      console.error(`[ModAnalysis] Error downloading or analyzing mod from URL: ${err.message}`);
      try {
        await fs.unlink(tempFile); // Attempt cleanup on error too
      } catch (cleanupErr) {
        // Ignore cleanup errors if main operation already failed
      }
      throw err; // Re-throw the error to be caught by the outer try-catch
    }
  } catch (error) {
    console.error('[ModAnalysis] Failed to analyze mod from URL:', error);
    return []; // Return empty or re-throw as per desired error handling
  }
}

module.exports = {
  extractDependenciesFromJar,
  analyzeModFromUrl
};
