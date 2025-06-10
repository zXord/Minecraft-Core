const fs = require('fs/promises');
const path = require('path');
const os = require('os');
const axios = require('axios');
const AdmZip = require('adm-zip').default;

async function extractDependenciesFromJar(jarPath) {
  try {
    try {
      await fs.access(jarPath);
    } catch {
      throw new Error(`Mod file does not exist: ${jarPath}`);
    }    try {
      const zip = new AdmZip(jarPath);
      const zipEntries = zip.getEntries();

      // Try fabric.mod.json
      const fabricEntry = zipEntries.find(entry =>
        entry.entryName === 'fabric.mod.json' ||
        entry.entryName.endsWith('/fabric.mod.json')
      );

      if (fabricEntry) {
        const content = fabricEntry.getData().toString('utf8');        try {
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
      );      if (forgeEntry) {
        const content = forgeEntry.getData().toString('utf8');
        try {
          const metadata = { loaderType: 'forge', authors: [], dependencies: [] };
          const lines = content.split(/\r?\n/);
          let currentModTable = {};
          let inModsArray = false;
          let inDescription = false;
          let currentDescription = [];

          lines.forEach(line => {
            const trimmedLine = line.trim();

            if (inDescription) {
              if (trimmedLine.endsWith("'''")) {
                currentDescription.push(trimmedLine.slice(0, -3));
                if (currentModTable) currentModTable.description = currentDescription.join('\n').trim();
                inDescription = false;
                currentDescription = [];
              } else {
                currentDescription.push(trimmedLine);
              }
              return;
            }

            if (trimmedLine.startsWith('modLoader')) metadata.modLoader = trimmedLine.split('=')[1]?.trim().replace(/"/g, '');
            if (trimmedLine.startsWith('loaderVersion')) metadata.loaderVersion = trimmedLine.split('=')[1]?.trim().replace(/"/g, '');
            if (trimmedLine.startsWith('license')) metadata.license = trimmedLine.split('=')[1]?.trim().replace(/"/g, '');
            if (trimmedLine.startsWith('issueTrackerURL')) metadata.issueTrackerURL = trimmedLine.split('=')[1]?.trim().replace(/"/g, '');

            if (trimmedLine === '[[mods]]') {
              inModsArray = true;
              if (!currentModTable) {
                currentModTable = {};
              }
            }

            if (inModsArray && currentModTable) {
              if (trimmedLine.startsWith('modId')) currentModTable.id = trimmedLine.split('=')[1]?.trim().replace(/"/g, '');
              if (trimmedLine.startsWith('version')) currentModTable.version = trimmedLine.split('=')[1]?.trim().replace(/"/g, '') || '${file.jarVersion}';
              if (trimmedLine.startsWith('displayName')) currentModTable.name = trimmedLine.split('=')[1]?.trim().replace(/"/g, '');
              if (trimmedLine.startsWith('authors')) currentModTable.authors = (trimmedLine.split('=')[1]?.trim().replace(/"/g, '') || '').split(',').map(a => a.trim()).filter(a => a);
              if (trimmedLine.startsWith('description')) {
                let desc = trimmedLine.substring(trimmedLine.indexOf('=') + 1).trim();
                if (desc.startsWith("'''")) {
                  if (desc.endsWith("'''") && desc.length > 5) {
                     currentModTable.description = desc.slice(3, -3).trim();
                  } else {
                    inDescription = true;
                    currentDescription.push(desc.slice(3));
                  }
                } else if (desc.startsWith('"') && desc.endsWith('"')) {
                  currentModTable.description = desc.slice(1, -1).trim();
                } else {
                    currentModTable.description = desc;
                }
              }
            }
            if (inModsArray && (trimmedLine.startsWith('[') && !trimmedLine.startsWith('[[dependencies')) && trimmedLine !== '[[mods]]') {
                inModsArray = false;
            }
          });
          
          if (currentModTable) {
            metadata.id = metadata.id || currentModTable.id;
            metadata.version = metadata.version || currentModTable.version;
            metadata.name = metadata.name || currentModTable.name || metadata.id;
            if (currentModTable.authors && currentModTable.authors.length > 0) {
                 metadata.authors = currentModTable.authors;
            }
            metadata.description = metadata.description || currentModTable.description;
          }
          metadata.projectId = metadata.projectId || metadata.id;

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
          const qmd = quiltJson.quilt_loader || quiltJson; // quilt_loader is primary, fallback to root
          
          const metadata = {
            loaderType: 'quilt',
            id: qmd.id,
            version: qmd.version,
            name: (qmd.metadata && qmd.metadata.name) || qmd.id,
            description: (qmd.metadata && qmd.metadata.description) || '',
            authors: [],
            projectId: qmd.id // Quilt uses 'id' as the project identifier
          };

          if (qmd.metadata && qmd.metadata.contributors) {
            metadata.authors = Object.keys(qmd.metadata.contributors);
          } else if (quiltJson.contributors) { // Fallback for older formats
             metadata.authors = Object.keys(quiltJson.contributors);
          }          return metadata;
        } catch {
          return null;
        }
      }
      
      return null;
    } catch {
      return null;
    }
  } catch {
    return null;
  }
}

async function analyzeModFromUrl(url, modId) {
  try {
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
    }
  } catch {
    return [];
  }
}

module.exports = {
  extractDependenciesFromJar,
  analyzeModFromUrl
};
