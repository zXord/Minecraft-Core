const path = require('path');
const fs = require('fs/promises');
const axios = require('axios');
const { createWriteStream } = require('fs');
const { pipeline } = require('stream');
const { promisify } = require('util');
const pipelineAsync = promisify(pipeline);

// Placeholder for API service functions - these will be imported later
// For now, we might have to define minimal stubs or expect them to be passed if complex
const {
  getModrinthDownloadUrl,
  getModrinthVersionInfo,
  getLatestModrinthVersionInfo,
  getCurseForgeDownloadUrl, // Assuming this might be needed
  getModrinthVersions // For installClientMod
} = require('../../services/mod-api-service.cjs'); // Adjust path as needed


async function installModToServer(win, serverPath, modDetails) {
  console.log('[ModInstallService] Attempting to install mod:', modDetails.name, 'to server path:', serverPath);
  if (!serverPath) {
    console.error('[ModInstallService] Server path is required for installing mods');
    return { success: false, error: 'Server path not provided' };
  }
  if (!modDetails || !modDetails.id || !modDetails.name) {
    console.error('[ModInstallService] Mod details (id, name) are required');
    return { success: false, error: 'Invalid mod details' };
  }

  const clientPath = path.join(serverPath, 'client');
  const modsDir = path.join(serverPath, 'mods');
  const clientModsDir = path.join(clientPath, 'mods');
  await fs.mkdir(modsDir, { recursive: true });
  await fs.mkdir(clientModsDir, { recursive: true });

  // Sanitize the name but avoid appending an extra .jar if it's already present
  const sanitizedBase = modDetails.name.replace(/[^a-zA-Z0-9_.-]/g, '_');
  const fileName = /\.jar$/i.test(sanitizedBase)
    ? sanitizedBase
    : `${sanitizedBase}.jar`;
  
  let currentModLocation = null;
  let destinationPath = path.join(modsDir, fileName); // Default to server
    if (modDetails.forceReinstall) {
    console.log('[ModInstallService] Checking current mod location for version update...');
    
    // Use old filename for location detection if provided (for updates)
    const checkFileName = modDetails.oldFileName || fileName;
    const serverModPath = path.join(modsDir, checkFileName);
    const clientModPath = path.join(clientModsDir, checkFileName);
    const serverExists = await fs.access(serverModPath).then(() => true).catch(() => false);
    const clientExists = await fs.access(clientModPath).then(() => true).catch(() => false);
    
    console.log(`[ModInstallService] Current mod locations (${checkFileName}) - Server: ${serverExists}, Client: ${clientExists}`);
    if (clientExists && serverExists) {
      currentModLocation = 'both';
      destinationPath = path.join(modsDir, fileName); // Install new version to server
    } else if (clientExists && !serverExists) {
      currentModLocation = 'client-only';
      destinationPath = path.join(clientModsDir, fileName); // Install new version to client
    } else if (serverExists && !clientExists) {
      currentModLocation = 'server-only';
      destinationPath = path.join(modsDir, fileName); // Install new version to server
    }
    
    console.log(`[ModInstallService] Detected current location: ${currentModLocation}, new file will go to: ${destinationPath}`);
  }
  
  const targetPath = destinationPath;
  if (modDetails.forceReinstall) {
    try {
      console.log('[ModInstallService] Checking for existing mod files to replace...');
      const manifestDir = path.join(serverPath, 'minecraft-core-manifests');
      const manifestFiles = await fs.readdir(manifestDir).catch(() => []);
      
      for (const manifestFile of manifestFiles) {
        if (!manifestFile.endsWith('.json')) continue;
        try {
          const manifestPath = path.join(manifestDir, manifestFile);
          const manifestContent = await fs.readFile(manifestPath, 'utf8');
          const manifest = JSON.parse(manifestContent);
          
          if (manifest.projectId === modDetails.id) {
            const existingFileName = manifest.fileName;
            console.log(`[ModInstallService] Found existing version of mod: ${existingFileName}`);
            
            // Clean up from both locations during update
            const serverFilePath = path.join(modsDir, existingFileName);
            const clientFilePath = path.join(clientModsDir, existingFileName);
            
            await fs.unlink(serverFilePath).catch(() => console.log(`[ModInstallService] Could not delete server file ${serverFilePath}, may not exist`));
            await fs.unlink(clientFilePath).catch(() => console.log(`[ModInstallService] Could not delete client file ${clientFilePath}, may not exist`));
            await fs.unlink(manifestPath).catch(() => console.log(`[ModInstallService] Could not delete manifest ${manifestPath}`));
            break;
          }
        } catch (err) {
          console.error(`[ModInstallService] Error parsing manifest ${manifestFile}:`, err);        }
      }
      
      // Also clean up using oldFileName if provided (for direct updates)
      if (modDetails.oldFileName && modDetails.oldFileName !== fileName) {
        console.log(`[ModInstallService] Cleaning up old file: ${modDetails.oldFileName}`);
        const oldServerPath = path.join(modsDir, modDetails.oldFileName);
        const oldClientPath = path.join(clientModsDir, modDetails.oldFileName);
        
        await fs.unlink(oldServerPath).catch(() => console.log(`[ModInstallService] Could not delete old server file ${oldServerPath}, may not exist`));
        await fs.unlink(oldClientPath).catch(() => console.log(`[ModInstallService] Could not delete old client file ${oldClientPath}, may not exist`));
      }
      
      if (modDetails.name) {
        const modFiles = await fs.readdir(modsDir);
        const baseName = modDetails.name.replace(/[^a-zA-Z0-9_.-]/g, '_');
        const possibleMatches = modFiles.filter(file => file.startsWith(baseName) && file.endsWith('.jar') && file !== fileName);
        for (const match of possibleMatches) {
          console.log(`[ModInstallService] Removing potential older version: ${match}`);
          await fs.unlink(path.join(modsDir, match)).catch(() => {});
        }
      }
    } catch (err) {
      console.error('[ModInstallService] Error checking for existing mod files:', err);
    }
  }
  try {
    let downloadUrl, versionInfoToSave;
    
    // Check if downloadUrl is already provided
    if (modDetails.downloadUrl) {
      downloadUrl = modDetails.downloadUrl;
      // If we have selectedVersionId, use it to get version info for manifest
      if (modDetails.selectedVersionId && modDetails.source === 'modrinth') {
        versionInfoToSave = await getModrinthVersionInfo(modDetails.id, modDetails.selectedVersionId);
      }
    } else if (modDetails.source === 'modrinth') {
      if (modDetails.selectedVersionId) {
        versionInfoToSave = await getModrinthVersionInfo(modDetails.id, modDetails.selectedVersionId);
        if (!versionInfoToSave || !versionInfoToSave.files || versionInfoToSave.files.length === 0) {
          throw new Error('No files found for selected version');
        }
        downloadUrl = versionInfoToSave.files[0].url;
      } else {
        // This part might need adjustment if getModrinthDownloadUrl is not just a URL string
        downloadUrl = await getModrinthDownloadUrl(modDetails.id, modDetails.version, modDetails.loader);
        versionInfoToSave = await getLatestModrinthVersionInfo(modDetails.id, modDetails.version, modDetails.loader);
      }
    } else if (modDetails.source === 'curseforge') {
      // Assuming getCurseForgeDownloadUrl exists and works similarly
      downloadUrl = await getCurseForgeDownloadUrl(modDetails.id, modDetails.version, modDetails.loader);
      // versionInfoToSave would need to be fetched for CurseForge too if manifest saving is desired for it
    } else {
      downloadUrl = modDetails.downloadUrl; // Direct URL
    }
    
    if (!downloadUrl) throw new Error('Failed to get download URL for mod');
    
    console.log(`[ModInstallService] Downloading mod from ${downloadUrl} to ${targetPath}`);
    const downloadId = `mod-${modDetails.id}-${Date.now()}`;
    
    if (win && win.webContents) {
      win.webContents.send('download-progress', { id: downloadId, name: modDetails.name, progress: 0, speed: 0, completed: false, error: null });
    }

    const writer = createWriteStream(targetPath);
    const response = await axios({
      url: downloadUrl, method: 'GET', responseType: 'stream',
      onDownloadProgress: progressEvent => {
        const progress = progressEvent.loaded / progressEvent.total;
        const speed = progressEvent.rate || 0;
        if (win && win.webContents) {
          win.webContents.send('download-progress', { id: downloadId, name: modDetails.name, progress: progress * 100, size: progressEvent.total, downloaded: progressEvent.loaded, speed: speed, completed: false, error: null });
        }
      }
    });

    await pipelineAsync(response.data, writer); // Use pipelineAsync

    if (currentModLocation === 'both') {
      console.log('[ModInstallService] Copying mod to other location for "both" category');
      const otherTargetPath = (destinationPath === path.join(modsDir, fileName)) ? path.join(clientModsDir, fileName) : path.join(modsDir, fileName);
      await fs.copyFile(targetPath, otherTargetPath);
      console.log(`[ModInstallService] Copied mod to: ${otherTargetPath}`);
    }

    if (win && win.webContents) {
      win.webContents.send('download-progress', { id: downloadId, name: modDetails.name, progress: 100, speed: 0, completed: true, completedTime: Date.now(), error: null });
    }

    if (modDetails.source === 'modrinth' && versionInfoToSave) {
      try {
        const serverManifestDir = path.join(serverPath, 'minecraft-core-manifests');
        const clientManifestDir = path.join(clientPath, 'minecraft-core-manifests');
        const manifest = {
          projectId: modDetails.id, name: modDetails.name, fileName: fileName, // Use the sanitized filename
          versionId: versionInfoToSave.id || modDetails.selectedVersionId,
          versionNumber: versionInfoToSave.version_number || versionInfoToSave.name || 'unknown',
          source: modDetails.source
        };

        if (currentModLocation === 'client-only') {
          await fs.mkdir(clientManifestDir, { recursive: true });
          const clientManifestPath = path.join(clientManifestDir, `${fileName}.json`);
          await fs.writeFile(clientManifestPath, JSON.stringify(manifest, null, 2));
        } else if (currentModLocation === 'both') {
          await fs.mkdir(serverManifestDir, { recursive: true });
          await fs.mkdir(clientManifestDir, { recursive: true });
          const serverManifestPath = path.join(serverManifestDir, `${fileName}.json`);
          const clientManifestPath = path.join(clientManifestDir, `${fileName}.json`);
          await fs.writeFile(serverManifestPath, JSON.stringify(manifest, null, 2));
          await fs.writeFile(clientManifestPath, JSON.stringify(manifest, null, 2));
        } else { // server-only or new install default
          await fs.mkdir(serverManifestDir, { recursive: true });
          const serverManifestPath = path.join(serverManifestDir, `${fileName}.json`);
          await fs.writeFile(serverManifestPath, JSON.stringify(manifest, null, 2));
        }
      } catch (manifestErr) {
        console.error('[ModInstallService] Failed to save mod manifest:', manifestErr);
      }
    }
    console.log('[ModInstallService] Mod installed successfully:', modDetails.name);
    return { success: true };
  } catch (err) {
    console.error('[ModInstallService] Failed to install mod:', err);
    let errorMessage = err.message || 'Unknown error';
     if (win && win.webContents && modDetails) {
      win.webContents.send('download-progress', { id: `mod-${modDetails.id}-${Date.now()}`, name: modDetails.name, progress: 0, speed: 0, completed: false, completedTime: Date.now(), error: errorMessage });
    }
    return { success: false, error: `Failed to install mod ${modDetails.name}: ${errorMessage}` };
  }
}

async function installModToClient(win, modData) {
  console.log('[ModInstallService] Installing mod to client:', modData.name, 'to path:', modData.clientPath);
  
  if (!modData.clientPath) throw new Error('Client path is required for client mod installation');
  if (!modData || !modData.id || !modData.name) throw new Error('Invalid mod details (id, name) are required');

  const clientModsDir = path.join(modData.clientPath, 'mods');
  await fs.mkdir(clientModsDir, { recursive: true });
  const clientManifestDir = path.join(modData.clientPath, 'minecraft-core-manifests');
  await fs.mkdir(clientManifestDir, { recursive: true });

  // Use a sanitized file name instead of the API provided one to
  // match the server install behaviour and avoid version suffixes.
  const sanitizedBase = modData.name.replace(/[^a-zA-Z0-9_.-]/g, '_');
  const sanitizedFileName = /\.jar$/i.test(sanitizedBase)
    ? sanitizedBase
    : `${sanitizedBase}.jar`;
  let targetPath = path.join(clientModsDir, sanitizedFileName); // Initial target path

  const fileExists = await fs.access(targetPath).then(() => true).catch(() => false);
  if (fileExists && !modData.forceReinstall) {
    console.log('[ModInstallService] Mod already exists in client, skipping installation');
    return { success: true, message: 'Mod already installed', fileName: sanitizedFileName };
  }

  if (modData.forceReinstall) {
    try {
      const manifestFiles = await fs.readdir(clientManifestDir).catch(() => []);
      for (const manifestFile of manifestFiles) {
        if (!manifestFile.endsWith('.json')) continue;
        const manifestPath = path.join(clientManifestDir, manifestFile);
        try {
          const manifestContent = await fs.readFile(manifestPath, 'utf8');
          const manifest = JSON.parse(manifestContent);
          if (manifest.projectId === modData.id) {
            const oldFilePath = path.join(clientModsDir, manifest.fileName);
            await fs.unlink(oldFilePath).catch(() => {});
            await fs.unlink(manifestPath).catch(() => {});
            break;
          }
        } catch {}
      }

      if (modData.name) {
        const modFiles = await fs.readdir(clientModsDir);
        const baseName = modData.name.replace(/[^a-zA-Z0-9_.-]/g, '_');
        const possibleMatches = modFiles.filter(f => f.startsWith(baseName) && f.endsWith('.jar'));
        for (const match of possibleMatches) {
          await fs.unlink(path.join(clientModsDir, match)).catch(() => {});
        }
      }
    } catch (err) {
      console.error('[ModInstallService] Error cleaning existing client mod:', err);
    }
  }

  try {
    const loader = modData.loader || 'fabric'; // Default or passed
    const mcVersion = modData.version || '1.20.1'; // Default or passed
    
    console.log('[ModInstallService] Getting mod versions for client installation:', {
      modId: modData.id,
      loader,
      mcVersion,
      selectedVersionId: modData.selectedVersionId
    });

    let versionInfo;
    let versionToInstall;

    if (modData.selectedVersionId) {
      // Try to fetch the requested version info
      try {
        versionInfo = await getModrinthVersionInfo(modData.id, modData.selectedVersionId);
        if (
          versionInfo &&
          (!loader || versionInfo.loaders.includes(loader)) &&
          (!mcVersion || versionInfo.game_versions.includes(mcVersion))
        ) {
          versionToInstall = { id: versionInfo.id, versionNumber: versionInfo.version_number };
        } else {
          console.warn('[ModInstallService] Requested version incompatible, falling back to best match');
          versionInfo = null;
        }
      } catch (err) {
        console.warn('[ModInstallService] Failed to fetch requested version, falling back:', err.message);
        versionInfo = null;
      }
    }

    // If no suitable version info found, pick the best compatible version automatically
    if (!versionInfo) {
      const versions = await getModrinthVersions(modData.id, loader, mcVersion, true);
      if (!versions || versions.length === 0) {
        throw new Error('No compatible versions found for this mod');
      }
      versionToInstall = versions[0];
      versionInfo = await getModrinthVersionInfo(modData.id, versionToInstall.id);
    }

    console.log('[ModInstallService] Selected version for client installation:', versionToInstall.versionNumber);
    if (!versionInfo.files || versionInfo.files.length === 0) throw new Error('No files found for this mod version');

    const primaryFile = versionInfo.files.find(file => file.primary) || versionInfo.files[0];
    const downloadUrl = primaryFile.url;

    // Use sanitized file name for storage to match server behaviour
    const fileName = sanitizedFileName;
    targetPath = path.join(clientModsDir, fileName);

    console.log(`[ModInstallService] Downloading client mod from ${downloadUrl} to ${targetPath}`);
    const downloadId = `client-mod-${modData.id}-${Date.now()}`;
    if (win && win.webContents) {
      win.webContents.send('download-progress', { id: downloadId, name: modData.name, progress: 0, speed: 0, completed: false, error: null });
    }

    const writer = createWriteStream(targetPath);
    const response = await axios({
      url: downloadUrl,
      method: 'GET',
      responseType: 'stream',
      timeout: 30000,
      onDownloadProgress: progressEvent => {
        const progress = progressEvent.loaded / progressEvent.total;
        const speed = progressEvent.rate || 0;
        if (win && win.webContents) {
          win.webContents.send('download-progress', { id: downloadId, name: modData.name, progress: progress * 100, size: progressEvent.total, downloaded: progressEvent.loaded, speed, completed: false, error: null });
        }
      }
    });

    await pipelineAsync(response.data, writer);

    if (win && win.webContents) {
      win.webContents.send('download-progress', { id: downloadId, name: modData.name, progress: 100, speed: 0, completed: true, completedTime: Date.now(), error: null });
    }

    console.log('[ModInstallService] Successfully downloaded mod to client:', targetPath);

    const manifestData = {
      projectId: modData.id, versionId: versionToInstall.id, fileName: fileName,
      name: modData.name, title: modData.title || modData.name, versionNumber: versionToInstall.versionNumber,
      mcVersion: mcVersion, loader: loader, source: 'modrinth', downloadUrl: downloadUrl,
      installedAt: new Date().toISOString(), filePath: targetPath, fileSize: primaryFile.size
    };
    const manifestPath = path.join(clientManifestDir, `${fileName}.json`);
    await fs.writeFile(manifestPath, JSON.stringify(manifestData, null, 2), 'utf8');
    console.log('[ModInstallService] Created manifest for client mod:', manifestPath);

    return { success: true, fileName: fileName, version: versionToInstall.versionNumber, versionId: versionToInstall.id, manifestPath };
  } catch (error) {
    console.error('[ModInstallService] Error installing mod to client:', error);
    // Clean up partially downloaded file
    await fs.unlink(targetPath).catch(e => console.warn(`[ModInstallService] Failed to cleanup temp file ${targetPath}: ${e.message}`));
    throw new Error(`Failed to install client mod ${modData.name}: ${error.message}`);
  }
}

module.exports = {
  installModToServer,
  installModToClient
};
