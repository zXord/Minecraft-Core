const path = require('path');
const fs = require('fs/promises');
const fsSync = require('fs');
const os = require('os');
const crypto = require('crypto');
const { app } = require('electron'); // Required for app.getPath('userData')
const AdmZip = require('adm-zip').default;

// Simple store implementation to persist mod categories
const configDir = path.join(app.getPath('userData'), 'config');
const configFile = path.join(configDir, 'mod-categories.json');

// Create config directory if it doesn't exist
if (!fsSync.existsSync(configDir)) {
  fsSync.mkdirSync(configDir, { recursive: true });
}

// Simple store object to manage mod categories
const modCategoriesStore = {  get: () => {
    try {
      if (fsSync.existsSync(configFile)) {
        const data = fsSync.readFileSync(configFile, 'utf8');
        return JSON.parse(data);
      }
      return [];
    } catch {
      return [];
    }
  },
  set: (data) => {
    try {
      fsSync.writeFileSync(configFile, JSON.stringify(data, null, 2), 'utf8');
      return true;
    } catch {
      return false;
    }
  }
};

function parseForgeToml(content) {
  const nameMatch = content.match(/displayName\s*=\s*"([^"]+)"/);
  const versionMatch = content.match(/version\s*=\s*"([^"]+)"/);
  const idMatch = content.match(/modId\s*=\s*"([^"]+)"/i);
  return {
    name: nameMatch ? nameMatch[1] : undefined,
    versionNumber: versionMatch ? versionMatch[1] : undefined,
    projectId: idMatch ? idMatch[1] : undefined
  };
}

async function readModMetadataFromJar(jarPath) {
  try {
    const zip = new AdmZip(jarPath);
    const entries = zip.getEntries();
    const fabric = entries.find(e =>
      e.entryName === 'fabric.mod.json' || e.entryName.endsWith('/fabric.mod.json')
    );    if (fabric) {
      try {
        const data = JSON.parse(fabric.getData().toString('utf8'));
        return {
          name: data.name || data.id,
          versionNumber: data.version || data.version_number,
          projectId: data.id
        };
      } catch {
        // Ignore fabric parsing errors
      }
    }
    const quilt = entries.find(e =>
      e.entryName === 'quilt.mod.json' || e.entryName.endsWith('/quilt.mod.json')
    );
    if (quilt) {
      try {
        const data = JSON.parse(quilt.getData().toString('utf8'));
        return {
          name: data.name || data.quilt_loader?.id,
          versionNumber: data.version,
          projectId: data.quilt_loader?.id
        };
      } catch {
        // Ignore quilt parsing errors
      }
    }
    const forge = entries.find(e =>
      e.entryName === 'META-INF/mods.toml' || e.entryName.endsWith('/META-INF/mods.toml')
    );    if (forge) {
      const text = forge.getData().toString('utf8');
      return parseForgeToml(text);
    }
  } catch {
    // Ignore metadata reading errors
  }
  return {};
}

async function listMods(serverPath) {
  
  if (!serverPath) {
    throw new Error('Server path is required for listing mods');
  }
    // Verify server path exists
  try {
    await fs.access(serverPath);
  } catch {
    throw new Error('Server directory does not exist or is inaccessible');
  }
  
  const clientPath = path.join(serverPath, 'client');
  
  
  const serverModsDir = path.join(serverPath, 'mods');
  const clientModsDir = path.join(clientPath, 'mods');
  const disabledModsDir = path.join(serverPath, 'mods_disabled');
    await fs.mkdir(serverModsDir, { recursive: true });
  await fs.mkdir(clientModsDir, { recursive: true }).catch(() => {
    // Ignore client mods directory creation errors
  });
  await fs.mkdir(disabledModsDir, { recursive: true });
  
  const serverFiles = await fs.readdir(serverModsDir);
  const serverModFiles = serverFiles.filter(file => file.toLowerCase().endsWith('.jar'));
    let clientModFiles = [];
  try {
    const clientFiles = await fs.readdir(clientModsDir);
    clientModFiles = clientFiles.filter(file => file.toLowerCase().endsWith('.jar'));
  } catch {
    // Ignore client directory read errors
  }
  
  const disabledFiles = await fs.readdir(disabledModsDir);
  const disabledModFiles = disabledFiles.filter(file => file.toLowerCase().endsWith('.jar'));
  
  const modsInBoth = serverModFiles.filter(mod => clientModFiles.includes(mod));
  const serverOnlyMods = serverModFiles.filter(mod => !clientModFiles.includes(mod));
  const clientOnlyMods = clientModFiles.filter(mod => !serverModFiles.includes(mod));
  
  const allMods = [
    ...serverOnlyMods.map(mod => ({ fileName: mod, locations: ['server'], category: 'server-only' })),
    ...clientOnlyMods.map(mod => ({ fileName: mod, locations: ['client'], category: 'client-only' })),
    ...modsInBoth.map(mod => ({ fileName: mod, locations: ['server', 'client'], category: 'both' })),
    ...disabledModFiles.map(mod => ({ fileName: mod, locations: ['disabled'], category: 'disabled' }))
  ];
  
  const allModFiles = [...new Set([...serverModFiles, ...clientModFiles, ...disabledModFiles])];
  
  
  return {
    mods: allMods,
    modFiles: allModFiles,
    serverPath,
    clientPath
  };
}

async function getInstalledModInfo(serverPath) {
  
  if (!serverPath) {
    throw new Error('Server path is required');
  }
  
  const clientPath = path.join(serverPath, 'client');
  const modsDir = path.join(serverPath, 'mods');
  const clientModsDir = path.join(clientPath, 'mods');
  await fs.mkdir(modsDir, { recursive: true });
  await fs.mkdir(clientModsDir, { recursive: true });
  
  const enabledFiles = await fs.readdir(modsDir);
  const enabledMods = enabledFiles.filter(file => file.toLowerCase().endsWith('.jar'));
    let clientMods = [];  try {
    const clientFiles = await fs.readdir(clientModsDir);
    clientMods = clientFiles.filter(file => file.toLowerCase().endsWith('.jar'));
  } catch {
    // Ignore client mods directory read errors
  }
  
  const disabledDir = path.join(serverPath, 'mods_disabled');
  await fs.mkdir(disabledDir, { recursive: true });
  const disabledFiles = (await fs.readdir(disabledDir).catch(() => []))
    .filter(file => file.toLowerCase().endsWith('.jar'));
  
  const allModFiles = [...new Set([...enabledMods, ...clientMods, ...disabledFiles])];
  
  const serverManifestDir = path.join(serverPath, 'minecraft-core-manifests');
  const clientManifestDir = path.join(clientPath, 'minecraft-core-manifests');
  let modInfo = [];
  
  try {
    await fs.mkdir(serverManifestDir, { recursive: true });
    await fs.mkdir(clientManifestDir, { recursive: true });
    
    for (const modFile of allModFiles) {
      const serverManifestPath = path.join(serverManifestDir, `${modFile}.json`);
      const clientManifestPath = path.join(clientManifestDir, `${modFile}.json`);
      let manifest = null;      try {
        await fs.readFile(clientManifestPath, 'utf8');
      } catch {
        try {
          const serverManifestContent = await fs.readFile(serverManifestPath, 'utf8');
          manifest = JSON.parse(serverManifestContent);
        } catch {
          // Ignore manifest parsing errors
        }
      }
        if (manifest) {
        if (!manifest.projectId || !manifest.versionNumber) {
          try {
            const jarBase = path.join(modsDir, modFile);
            const jarPath = await fs
              .access(jarBase)
              .then(() => jarBase)
              .catch(async () => {
                const disabledPath = jarBase + '.disabled';
                try {
                  await fs.access(disabledPath);
                  return disabledPath;
                } catch {
                  return null;
                }              });
            if (jarPath) {
              const meta = await readModMetadataFromJar(jarPath);
              // Preserve manifest projectId if it exists and looks like a Modrinth ID
              const shouldPreserveManifestProjectId = manifest.projectId && 
                (manifest.projectId.length === 8 || manifest.projectId.length === 9) && 
                /^[A-Za-z0-9]{8,9}$/.test(manifest.projectId);
              
              // Store the original manifest projectId before merging
              const originalProjectId = manifest.projectId;
              
              manifest = { 
                ...meta, 
                ...manifest, 
                // Always preserve proper Modrinth project ID if it exists in manifest
                projectId: shouldPreserveManifestProjectId ? originalProjectId : (meta.projectId || originalProjectId), 
                versionNumber: manifest.versionNumber || meta.versionNumber, 
                name: manifest.name || meta.name 
              };            }
          } catch {
            // Ignore metadata extraction errors
          }
        }
        modInfo.push(manifest);
      }
    }
  } catch {
    // Ignore manifest processing errors
  }
  
  return modInfo;
}

// Get installed mod info for a standalone client path
async function getClientInstalledModInfo(clientPath) {

  if (!clientPath) {
    throw new Error('Client path is required');
  }

  const modsDir = path.join(clientPath, 'mods');
  const manifestDir = path.join(clientPath, 'minecraft-core-manifests');
  
  await fs.mkdir(modsDir, { recursive: true });
  await fs.mkdir(manifestDir, { recursive: true });

  const files = await fs.readdir(modsDir).catch(() => []);
  
  const modFiles = files
    .filter(f =>
      f.toLowerCase().endsWith('.jar') || f.toLowerCase().endsWith('.jar.disabled')
    )
    .map(f => f.replace('.disabled', ''));

  const uniqueModFiles = Array.from(new Set(modFiles));

  const modInfo = [];
  for (const file of uniqueModFiles) {
    const manifestPath = path.join(manifestDir, `${file}.json`);
    let manifest = null;    try {
      const content = await fs.readFile(manifestPath, 'utf8');
      manifest = JSON.parse(content);
      if (!manifest.projectId || !manifest.versionNumber) {
        try {
          const jarBase = path.join(modsDir, file);
          const jarPath = await fs
            .access(jarBase)
            .then(() => jarBase)
            .catch(async () => {
              const disabledPath = jarBase + '.disabled';
              try {
                await fs.access(disabledPath);
                return disabledPath;
              } catch {
                return null;
              }
            });          if (jarPath) {
            const meta = await readModMetadataFromJar(jarPath);
            // Preserve manifest projectId if it exists and looks like a Modrinth ID
            const shouldPreserveManifestProjectId = manifest.projectId && 
              (manifest.projectId.length === 8 || manifest.projectId.length === 9) && 
              /^[A-Za-z0-9]{8,9}$/.test(manifest.projectId);
            
            // Store the original manifest projectId before merging
            const originalProjectId = manifest.projectId;
            
            manifest = { 
              ...meta, 
              ...manifest, 
              // Always preserve proper Modrinth project ID if it exists in manifest
              projectId: shouldPreserveManifestProjectId ? originalProjectId : (meta.projectId || originalProjectId), 
              versionNumber: manifest.versionNumber || meta.versionNumber, 
              name: manifest.name || meta.name 
            };          }
        } catch {
          // Ignore metadata extraction errors
        }
      }
      modInfo.push(manifest);
    } catch {
      // Ignore manifest processing errors
    }

    if (!manifest) {
      const jarBase = path.join(modsDir, file);
      const jarPath = await fs
        .access(jarBase)
        .then(() => {
          return jarBase;
        })
        .catch(async () => {
          const disabledPath = jarBase + '.disabled';
          try {
            await fs.access(disabledPath);
            return disabledPath;
          } catch {
            return null;
          }
        });      let meta = {};
      if (jarPath) {
        meta = await readModMetadataFromJar(jarPath);
      }

      const modData = { fileName: file, ...meta };
      modInfo.push(modData);
    }
  }

  return modInfo;
}

async function saveDisabledMods(serverPath, disabledMods) {
  
  if (!serverPath) {
    throw new Error('Server path is required');
  }
  if (!Array.isArray(disabledMods)) {
    throw new Error('Disabled mods must be an array');
  }
  
  const configDirMgr = path.join(serverPath, 'minecraft-core-configs');
  await fs.mkdir(configDirMgr, { recursive: true });
  
  const disabledModsPath = path.join(configDirMgr, 'disabled-mods.json');
  await fs.writeFile(disabledModsPath, JSON.stringify(disabledMods, null, 2));
  
  const modsDir = path.join(serverPath, 'mods');
  const disabledModsDir = path.join(serverPath, 'mods_disabled');
  
  await fs.mkdir(modsDir, { recursive: true });
  await fs.mkdir(disabledModsDir, { recursive: true });
  
  const enabledFiles = await fs.readdir(modsDir);
  const currentDisabledFiles = await fs.readdir(disabledModsDir);
  
  
  for (const modFile of enabledFiles) {
    if (modFile.toLowerCase().endsWith('.jar') && disabledMods.includes(modFile)) {
      const sourcePath = path.join(modsDir, modFile);
      const destPath = path.join(disabledModsDir, modFile);
      try {
        await fs.copyFile(sourcePath, destPath);
        await fs.unlink(sourcePath);
      } catch (moveErr) {
        throw new Error(`Failed to disable mod ${modFile}: ${moveErr.message}`);
      }
    }
  }
  
  for (const modFile of currentDisabledFiles) {
    if (modFile.toLowerCase().endsWith('.jar') && !disabledMods.includes(modFile)) {
      const sourcePath = path.join(disabledModsDir, modFile);
      const destPath = path.join(modsDir, modFile);
      try {
        await fs.copyFile(sourcePath, destPath);
        await fs.unlink(sourcePath);
      } catch (moveErr) {
        throw new Error(`Failed to enable mod ${modFile}: ${moveErr.message}`);      }
    }
  }
  
  return true;
}

async function getDisabledMods(serverPath) {
  
  if (!serverPath) {
    throw new Error('Server path is required');
  }
  
  const modsDir = path.join(serverPath, 'mods');
  const disabledModsDir = path.join(serverPath, 'mods_disabled');
  
  await fs.mkdir(modsDir, { recursive: true });
  await fs.mkdir(disabledModsDir, { recursive: true });
  
  const configDirMgr = path.join(serverPath, 'minecraft-core-configs');
  await fs.mkdir(configDirMgr, { recursive: true });
  
  const disabledModsPath = path.join(configDirMgr, 'disabled-mods.json');
  let disabledMods = [];
  try {
    const disabledModsContent = await fs.readFile(disabledModsPath, 'utf8');
    disabledMods = JSON.parse(disabledModsContent);
    if (!Array.isArray(disabledMods)) {
      throw new Error('Invalid disabled mods format');    }
  } catch {
    disabledMods = [];
  }
  
  try {
    const currentDisabledFiles = await fs.readdir(disabledModsDir);
    const disabledModFileNames = currentDisabledFiles.filter(file => file.toLowerCase().endsWith('.jar'));
    for (const modFile of disabledModFileNames) {
      if (!disabledMods.includes(modFile)) {
        disabledMods.push(modFile);
      }    }
    await fs.writeFile(disabledModsPath, JSON.stringify(disabledMods, null, 2));
  } catch {
    // Ignore disabled mods file operations errors
  }
  
  return disabledMods;
}

async function addMod(serverPath, modPath) {
  
  if (!serverPath) {
    throw new Error('Server path is required');
  }
  if (!modPath) {
    throw new Error('Mod path is required');
  }
  
  try {
    const stats = await fs.stat(modPath);
    if (!stats.isFile()) {
      throw new Error(`Not a file: ${modPath}`);
    }
  } catch (statErr) {
    throw new Error(`Source file not accessible: ${statErr.message}`);
  }
  
  const modsDir = path.join(serverPath, 'mods');
  const fileName = path.basename(modPath);
  const targetPath = path.join(modsDir, fileName);
  
  await fs.mkdir(modsDir, { recursive: true });
  
  try {
    await fs.copyFile(modPath, targetPath);
  } catch (copyErr) {
    throw new Error(`Failed to copy mod file: ${copyErr.message}`);
  }
    try {
    await fs.stat(targetPath);
  } catch (verifyErr) {
    throw new Error(`Failed to verify copied file: ${verifyErr.message}`);
  }
  
  return true;
}

async function deleteMod(serverPath, modName) {
  
  if (!serverPath) {
    throw new Error('Server path is required');
  }
  if (!modName) {
    throw new Error('Mod name is required');
  }
  
  const fileName = modName.endsWith('.jar') ? modName : `${modName}.jar`;
  
  // Check multiple possible locations for the mod file
  const possiblePaths = [
    path.join(serverPath, 'mods', fileName),
    path.join(serverPath, 'client', 'mods', fileName),
    path.join(serverPath, 'mods_disabled', fileName)
  ];
  
  let deletedFromPaths = [];
  let deletionErrors = [];
  
  for (const modPath of possiblePaths) {    try {
      await fs.access(modPath);  // Check if file exists
      await fs.unlink(modPath);  // Delete the file
      deletedFromPaths.push(modPath);
      // Don't break - continue checking other locations
    } catch (error) {
      if (error.code === 'ENOENT') {
        // File doesn't exist, ignore
      } else {
        deletionErrors.push({ path: modPath, error: error.message });
      }
    }
  }
  
  // Also try to delete associated manifest files
  const manifestPaths = [
    path.join(serverPath, 'minecraft-core-manifests', `${fileName}.json`),
    path.join(serverPath, 'client', 'minecraft-core-manifests', `${fileName}.json`)
  ];
  
  for (const manifestPath of manifestPaths) {
    try {
      await fs.access(manifestPath);
      await fs.unlink(manifestPath);    } catch (error) {
      // Silently ignore manifest deletion errors as they're not critical
      if (error.code !== 'ENOENT') {
        // Log other errors but don't fail the operation
      }
    }
  }
  
  if (deletedFromPaths.length === 0) {
    if (deletionErrors.length > 0) {
      const errorMsg = deletionErrors.map(e => `${e.path}: ${e.error}`).join('; ');
      throw new Error(`Failed to delete mod from any location. Errors: ${errorMsg}`);
    } else {
      // Return success even if file wasn't found - it's already "deleted"
      return { success: true, message: `Mod ${fileName} was not found (may have been already deleted)`, deletedFrom: 'not_found' };
    }
  }
  
  // Create a user-friendly message about what was deleted
  let deletionMessage = `Mod ${fileName} deleted successfully`;
  if (deletedFromPaths.length > 1) {
    deletionMessage += ` from ${deletedFromPaths.length} locations`;
  }
  
  return { 
    success: true, 
    message: deletionMessage, 
    deletedFrom: deletedFromPaths,
    deletedFromCount: deletedFromPaths.length
  };
}

async function saveTemporaryFile({ name, buffer }) {
  
  if (!buffer || !Array.isArray(buffer) || buffer.length === 0) {
    throw new Error('Invalid or empty buffer received');
  }
  
  const tempDir = path.join(os.tmpdir(), 'minecraft-core-mods');
  await fs.mkdir(tempDir, { recursive: true });
  
  const hash = crypto.createHash('md5').update(`${name}-${Date.now()}`).digest('hex').slice(0, 8);
  const tempFilePath = path.join(tempDir, `${hash}-${name}`);
    const uint8Array = new Uint8Array(buffer);
  await fs.writeFile(tempFilePath, uint8Array);
  
  await fs.stat(tempFilePath);
  
  return tempFilePath;
}

async function directAddMod({ serverPath, fileName, buffer }) {
  
  if (!serverPath) {
    throw new Error('Server path is required');
  }
  if (!fileName) {
    throw new Error('File name is required');
  }
  if (!buffer || !Array.isArray(buffer) || buffer.length === 0) {
    throw new Error('Valid file buffer is required');
  }
  
  const modsDir = path.join(serverPath, 'mods');
  const targetPath = path.join(modsDir, fileName);
    await fs.mkdir(modsDir, { recursive: true });
  await fs.writeFile(targetPath, new Uint8Array(buffer));
  
  await fs.stat(targetPath);
  
  return true;
}

async function moveModFile({ fileName, newCategory, serverPath }) {
  
  if (!fileName) throw new Error('Filename is required');
  if (!newCategory) throw new Error('New category is required');
  if (!serverPath) throw new Error('Server path is required');

  const clientPath = path.join(serverPath, 'client');
  const serverModsDir = path.join(serverPath, 'mods');
  const clientModsDir = path.join(clientPath, 'mods');
  const disabledModsDir = path.join(serverPath, 'mods_disabled');
  const serverManifestDir = path.join(serverPath, 'minecraft-core-manifests');
  const clientManifestDir = path.join(clientPath, 'minecraft-core-manifests');

  await fs.mkdir(serverModsDir, { recursive: true });
  await fs.mkdir(clientModsDir, { recursive: true }).catch(err => {
    throw new Error(`Could not create client mods directory: ${err.message}`);
  });
  await fs.mkdir(disabledModsDir, { recursive: true });
  await fs.mkdir(serverManifestDir, { recursive: true });
  await fs.mkdir(clientManifestDir, { recursive: true });

  const serverModPath = path.join(serverModsDir, fileName);
  const clientModPath = path.join(clientModsDir, fileName);
  const disabledModPath = path.join(disabledModsDir, fileName);
  const serverManifestPath = path.join(serverManifestDir, `${fileName}.json`);
  const clientManifestPath = path.join(clientManifestDir, `${fileName}.json`);

  const fileExists = async (filePath) => fs.access(filePath).then(() => true).catch(() => false);

  const serverFileExists = await fileExists(serverModPath);
  const clientFileExists = await fileExists(clientModPath);
  const disabledFileExists = await fileExists(disabledModPath);
  const serverManifestExists = await fileExists(serverManifestPath);
  const clientManifestExists = await fileExists(clientManifestPath);


  const copyAndUnlink = async (source, dest) => {
    await fs.copyFile(source, dest);
    await fs.unlink(source);
  };

  if (newCategory === 'server-only') {
    if (clientFileExists) {
      if (!serverFileExists) await copyAndUnlink(clientModPath, serverModPath);
      else await fs.unlink(clientModPath); // Already in server, just remove from client
      if (clientManifestExists) {
        if (!serverManifestExists) await copyAndUnlink(clientManifestPath, serverManifestPath);
        else await fs.unlink(clientManifestPath);
      }
    } else if (disabledFileExists && !serverFileExists) {
      await copyAndUnlink(disabledModPath, serverModPath);
      // Manifest for disabled mods is usually in serverManifestDir, so no manifest move needed here
    }
  } else if (newCategory === 'client-only') {
    if (serverFileExists) {
      if (!clientFileExists) await copyAndUnlink(serverModPath, clientModPath);
      else await fs.unlink(serverModPath);
      if (serverManifestExists) {
        if (!clientManifestExists) await copyAndUnlink(serverManifestPath, clientManifestPath);
        else await fs.unlink(serverManifestPath);
      }
    } else if (disabledFileExists && !clientFileExists) {      await copyAndUnlink(disabledModPath, clientModPath);
      if (serverManifestExists && !clientManifestExists) {
         await copyAndUnlink(serverManifestPath, clientManifestPath);
      }
    }
  } else if (newCategory === 'both') {
    if (serverFileExists && !clientFileExists) {
      await fs.copyFile(serverModPath, clientModPath);
      if (serverManifestExists && !clientManifestExists) await fs.copyFile(serverManifestPath, clientManifestPath);
    } else if (!serverFileExists && clientFileExists) {
      await fs.copyFile(clientModPath, serverModPath);
      if (clientManifestExists && !serverManifestExists) await fs.copyFile(clientManifestPath, serverManifestPath);
    } else if (disabledFileExists) {
      if(!serverFileExists) await fs.copyFile(disabledModPath, serverModPath);
      if(!clientFileExists) await fs.copyFile(disabledModPath, clientModPath);
      await fs.unlink(disabledModPath);
      if (serverManifestExists) { // Assuming manifest for disabled was in server
          if(!clientManifestExists) await fs.copyFile(serverManifestPath, clientManifestPath);
      }
    }
  } else if (newCategory === 'disabled') {
    if (serverFileExists) {
      if (!disabledFileExists) await copyAndUnlink(serverModPath, disabledModPath);
      else await fs.unlink(serverModPath);
      // Keep server manifest for disabled mods, remove client manifest if it exists by mistake
      if (clientManifestExists) await fs.unlink(clientManifestPath);
    } else if (clientFileExists) {
      if (!disabledFileExists) await copyAndUnlink(clientModPath, disabledModPath);
      else await fs.unlink(clientModPath);
      if (clientManifestExists && !serverManifestExists) await copyAndUnlink(clientManifestPath, serverManifestPath);
      else if (clientManifestExists) await fs.unlink(clientManifestPath);
    }
  }
  return { success: true, category: newCategory };
}


module.exports = {
  modCategoriesStore,
  listMods,
  getInstalledModInfo,
  getClientInstalledModInfo,
  saveDisabledMods,
  getDisabledMods,
  addMod,
  deleteMod,
  saveTemporaryFile,
  directAddMod,
  moveModFile,
  readModMetadataFromJar
};
