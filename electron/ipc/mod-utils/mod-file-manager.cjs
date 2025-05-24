const path = require('path');
const fs = require('fs/promises');
const fsSync = require('fs');
const os = require('os');
const crypto = require('crypto');
const { app } = require('electron'); // Required for app.getPath('userData')

// Simple store implementation to persist mod categories
const configDir = path.join(app.getPath('userData'), 'config');
const configFile = path.join(configDir, 'mod-categories.json');

// Create config directory if it doesn't exist
if (!fsSync.existsSync(configDir)) {
  fsSync.mkdirSync(configDir, { recursive: true });
}

// Simple store object to manage mod categories
const modCategoriesStore = {
  get: () => {
    try {
      if (fsSync.existsSync(configFile)) {
        const data = fsSync.readFileSync(configFile, 'utf8');
        return JSON.parse(data);
      }
      return [];
    } catch (error) {
      console.error('Error reading mod categories:', error);
      return [];
    }
  },
  set: (data) => {
    try {
      fsSync.writeFileSync(configFile, JSON.stringify(data, null, 2), 'utf8');
      return true;
    } catch (error) {
      console.error('Error writing mod categories:', error);
      return false;
    }
  }
};

async function listMods(serverPath) {
  console.log('[ModManager] Listing mods from:', serverPath);
  
  if (!serverPath) {
    throw new Error('Server path is required for listing mods');
  }
  
  // Verify server path exists
  try {
    await fs.access(serverPath);
  } catch (err) {
    throw new Error('Server directory does not exist or is inaccessible');
  }
  
  const clientPath = path.join(serverPath, 'client');
  
  console.log('[ModManager] Server path:', serverPath);
  console.log('[ModManager] Client path:', clientPath);
  
  const serverModsDir = path.join(serverPath, 'mods');
  const clientModsDir = path.join(clientPath, 'mods');
  const disabledModsDir = path.join(serverPath, 'mods_disabled');
  
  await fs.mkdir(serverModsDir, { recursive: true });
  await fs.mkdir(clientModsDir, { recursive: true }).catch(err => {
    console.warn('[ModManager] Could not create client mods directory:', err);
  });
  await fs.mkdir(disabledModsDir, { recursive: true });
  
  const serverFiles = await fs.readdir(serverModsDir);
  const serverModFiles = serverFiles.filter(file => file.endsWith('.jar'));
  
  let clientModFiles = [];
  try {
    const clientFiles = await fs.readdir(clientModsDir);
    clientModFiles = clientFiles.filter(file => file.endsWith('.jar'));
  } catch (err) {
    console.warn('[ModManager] Could not read client mods directory:', err);
  }
  
  const disabledFiles = await fs.readdir(disabledModsDir);
  const disabledModFiles = disabledFiles.filter(file => file.endsWith('.jar'));
  
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
  
  console.log('[ModManager] Found mods:', allMods);
  console.log('[ModManager] All mod filenames:', allModFiles);
  
  return {
    mods: allMods,
    modFiles: allModFiles,
    serverPath,
    clientPath
  };
}

async function getInstalledModInfo(serverPath) {
  console.log('[ModManager] Getting installed mod info from:', serverPath);
  
  if (!serverPath) {
    throw new Error('Server path is required');
  }
  
  const clientPath = path.join(serverPath, 'client');
  const modsDir = path.join(serverPath, 'mods');
  const clientModsDir = path.join(clientPath, 'mods');
  await fs.mkdir(modsDir, { recursive: true });
  await fs.mkdir(clientModsDir, { recursive: true });
  
  const enabledFiles = await fs.readdir(modsDir);
  const enabledMods = enabledFiles.filter(file => file.endsWith('.jar'));
  
  let clientMods = [];
  try {
    const clientFiles = await fs.readdir(clientModsDir);
    clientMods = clientFiles.filter(file => file.endsWith('.jar'));
  } catch (err) {
    console.warn('[ModManager] Could not read client mods:', err);
  }
  
  const disabledDir = path.join(serverPath, 'mods_disabled');
  await fs.mkdir(disabledDir, { recursive: true });
  const disabledFiles = (await fs.readdir(disabledDir).catch(() => [])).filter(file => file.endsWith('.jar'));
  
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
      let manifest = null;
      
      try {
        const clientManifestContent = await fs.readFile(clientManifestPath, 'utf8');
        manifest = JSON.parse(clientManifestContent);
        console.log(`[ModManager] Found client manifest for ${modFile}`);
      } catch (clientManifestErr) {
        try {
          const serverManifestContent = await fs.readFile(serverManifestPath, 'utf8');
          manifest = JSON.parse(serverManifestContent);
          console.log(`[ModManager] Found server manifest for ${modFile}`);
        } catch (serverManifestErr) {
          console.log(`[ModManager] No manifest found for ${modFile} in either location`);
        }
      }
      
      if (manifest) {
        modInfo.push(manifest);
      }
    }
  } catch (manifestDirErr) {
    console.error('[ModManager] Error accessing manifest directories:', manifestDirErr);
  }
  
  console.log(`[ModManager] Found ${modInfo.length} mod manifests out of ${allModFiles.length} total mods`);
  return modInfo;
}

async function saveDisabledMods(serverPath, disabledMods) {
  console.log('[ModManager] Saving disabled mods:', disabledMods);
  
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
  
  console.log(`[ModManager] Enabled mods directory (${modsDir}) contains:`, enabledFiles);
  console.log(`[ModManager] Disabled mods directory (${disabledModsDir}) contains:`, currentDisabledFiles);
  console.log(`[ModManager] Desired disabled mods list contains:`, disabledMods);
  
  for (const modFile of enabledFiles) {
    if (modFile.endsWith('.jar') && disabledMods.includes(modFile)) {
      const sourcePath = path.join(modsDir, modFile);
      const destPath = path.join(disabledModsDir, modFile);
      console.log(`[ModManager] Disabling mod by moving: ${sourcePath} -> ${destPath}`);
      try {
        await fs.copyFile(sourcePath, destPath);
        await fs.unlink(sourcePath);
        console.log(`[ModManager] Successfully moved mod to disabled folder: ${modFile}`);
      } catch (moveErr) {
        console.error(`[ModManager] Error moving mod to disabled folder: ${moveErr.message}`);
        throw new Error(`Failed to disable mod ${modFile}: ${moveErr.message}`);
      }
    }
  }
  
  for (const modFile of currentDisabledFiles) {
    if (modFile.endsWith('.jar') && !disabledMods.includes(modFile)) {
      const sourcePath = path.join(disabledModsDir, modFile);
      const destPath = path.join(modsDir, modFile);
      console.log(`[ModManager] Enabling mod by moving: ${sourcePath} -> ${destPath}`);
      try {
        await fs.copyFile(sourcePath, destPath);
        await fs.unlink(sourcePath);
        console.log(`[ModManager] Successfully moved mod back to enabled folder: ${modFile}`);
      } catch (moveErr) {
        console.error(`[ModManager] Error moving mod from disabled folder: ${moveErr.message}`);
        throw new Error(`Failed to enable mod ${modFile}: ${moveErr.message}`);
      }
    }
  }
  
  const newEnabledFiles = await fs.readdir(modsDir);
  const newDisabledFiles = await fs.readdir(disabledModsDir);
  console.log(`[ModManager] After moves, enabled mods:`, newEnabledFiles);
  console.log(`[ModManager] After moves, disabled mods:`, newDisabledFiles);
  
  console.log('[ModManager] Disabled mods saved and physically moved');
  return true;
}

async function getDisabledMods(serverPath) {
  console.log('[ModManager] Getting disabled mods from:', serverPath);
  
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
      throw new Error('Invalid disabled mods format');
    }
  } catch (fileErr) {
    console.log('[ModManager] No disabled mods config found or error reading file:', fileErr.message);
    disabledMods = [];
  }
  
  try {
    const currentDisabledFiles = await fs.readdir(disabledModsDir);
    const disabledModFileNames = currentDisabledFiles.filter(file => file.endsWith('.jar'));
    for (const modFile of disabledModFileNames) {
      if (!disabledMods.includes(modFile)) {
        disabledMods.push(modFile);
      }
    }
    await fs.writeFile(disabledModsPath, JSON.stringify(disabledMods, null, 2));
  } catch (disabledFolderErr) {
    console.error('[ModManager] Error checking disabled mods folder:', disabledFolderErr);
  }
  
  console.log('[ModManager] Loaded disabled mods:', disabledMods);
  return disabledMods;
}

async function addMod(serverPath, modPath) {
  console.log('[ModManager] Adding mod:', { serverPath, modPath });
  
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
    console.log(`[ModManager] Source file exists: ${modPath} (${stats.size} bytes)`);
  } catch (statErr) {
    console.error('[ModManager] Error checking source file:', statErr);
    throw new Error(`Source file not accessible: ${statErr.message}`);
  }
  
  const modsDir = path.join(serverPath, 'mods');
  const fileName = path.basename(modPath);
  const targetPath = path.join(modsDir, fileName);
  
  console.log('[ModManager] Target path:', targetPath);
  await fs.mkdir(modsDir, { recursive: true });
  
  try {
    await fs.copyFile(modPath, targetPath);
    console.log('[ModManager] Copied mod to:', targetPath);
  } catch (copyErr) {
    console.error('[ModManager] Error copying file:', copyErr);
    throw new Error(`Failed to copy mod file: ${copyErr.message}`);
  }
  
  try {
    const stats = await fs.stat(targetPath);
    console.log(`[ModManager] Target file verified: ${targetPath} (${stats.size} bytes)`);
  } catch (verifyErr) {
    console.error('[ModManager] Error verifying target file:', verifyErr);
    throw new Error(`Failed to verify copied file: ${verifyErr.message}`);
  }
  
  return true;
}

async function deleteMod(serverPath, modName) {
  console.log('[ModManager] Deleting mod:', { serverPath, modName });
  
  if (!serverPath) {
    throw new Error('Server path is required');
  }
  if (!modName) {
    throw new Error('Mod name is required');
  }
  
  const fileName = modName.endsWith('.jar') ? modName : `${modName}.jar`;
  const modPath = path.join(serverPath, 'mods', fileName);
  
  console.log('[ModManager] Mod path to delete:', modPath);
  await fs.unlink(modPath);
  console.log('[ModManager] Deleted mod:', modPath);
  
  return true;
}

async function saveTemporaryFile({ name, buffer }) {
  console.log(`[ModManager] Saving temporary file: ${name}, buffer length: ${buffer ? buffer.length : 'undefined'}`);
  
  if (!buffer || !Array.isArray(buffer) || buffer.length === 0) {
    throw new Error('Invalid or empty buffer received');
  }
  
  const tempDir = path.join(os.tmpdir(), 'minecraft-core-mods');
  await fs.mkdir(tempDir, { recursive: true });
  
  const hash = crypto.createHash('md5').update(`${name}-${Date.now()}`).digest('hex').slice(0, 8);
  const tempFilePath = path.join(tempDir, `${hash}-${name}`);
  
  const uint8Array = new Uint8Array(buffer);
  await fs.writeFile(tempFilePath, uint8Array);
  
  const stats = await fs.stat(tempFilePath);
  console.log(`[ModManager] Temporary file saved to: ${tempFilePath} (${stats.size} bytes)`);
  
  return tempFilePath;
}

async function directAddMod({ serverPath, fileName, buffer }) {
  console.log(`[ModManager] Direct adding mod: ${fileName} to ${serverPath}`);
  
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
  
  console.log(`[ModManager] Target path for direct mod: ${targetPath}`);
  await fs.mkdir(modsDir, { recursive: true });
  await fs.writeFile(targetPath, new Uint8Array(buffer));
  
  const stats = await fs.stat(targetPath);
  console.log(`[ModManager] Direct mod added: ${targetPath} (${stats.size} bytes)`);
  
  return true;
}

async function moveModFile({ fileName, newCategory, serverPath }) {
  console.log(`[ModManager] Moving mod ${fileName} to category ${newCategory}, with serverPath ${serverPath}`);
  
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
    console.warn('[ModManager] Could not create client mods directory:', err);
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

  console.log('[ModManager] File exists status - Server:', serverFileExists, 'Client:', clientFileExists, 'Disabled:', disabledFileExists);
  console.log('[ModManager] Manifest exists status - Server:', serverManifestExists, 'Client:', clientManifestExists);

  const copyAndUnlink = async (source, dest) => {
    await fs.copyFile(source, dest);
    await fs.unlink(source);
  };

  if (newCategory === 'server-only') {
    if (clientFileExists) {
      console.log('[ModManager] Moving from client to server-only');
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
    console.log('[ModManager] Moving to client-only');
    if (serverFileExists) {
      if (!clientFileExists) await copyAndUnlink(serverModPath, clientModPath);
      else await fs.unlink(serverModPath);
      if (serverManifestExists) {
        if (!clientManifestExists) await copyAndUnlink(serverManifestPath, clientManifestPath);
        else await fs.unlink(serverManifestPath);
      }
    } else if (disabledFileExists && !clientFileExists) {
      await copyAndUnlink(disabledModPath, clientModPath);
      if (serverManifestExists && !clientManifestExists) { // Manifest for disabled mod might be in server
         await copyAndUnlink(serverManifestPath, clientManifestPath);
      }
    } else {
      console.log('[ModManager] WARNING: Could not find the mod file in any location when moving to client-only');
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
  saveDisabledMods,
  getDisabledMods,
  addMod,
  deleteMod,
  saveTemporaryFile,
  directAddMod,
  moveModFile
};
