const fs = require('fs');
const path = require('path');
const axios = require('axios');
const { createWriteStream } = require('fs');
const { mkdir } = require('fs/promises');
const { app, BrowserWindow } = require('electron');

/**
 * Client Download Manager
 * Handles downloading Minecraft client, Fabric loader, and required mods
 */
class ClientDownloadManager {
  constructor(mainWindow) {
    this.mainWindow = mainWindow;
    this.downloadQueue = [];
    this.currentDownload = null;
    this.isDownloading = false;
  }

  /**
   * Download the Minecraft client
   * @param {Object} options - Download options
   * @param {string} options.clientPath - Path to download client to
   * @param {string} options.mcVersion - Minecraft version to download
   * @returns {Promise<boolean>} Success status
   */
  async downloadMinecraftClient(options) {
    try {
      if (!options.clientPath || !options.mcVersion) {
        throw new Error('Missing client path or Minecraft version');
      }

      // Create the Minecraft directory if it doesn't exist
      await this.ensureDirectoryExists(options.clientPath);
      
      // Get official download URL from Mojang
      const versionManifestUrl = 'https://launchermeta.mojang.com/mc/game/version_manifest.json';
      const manifestResponse = await axios.get(versionManifestUrl);
      const versions = manifestResponse.data.versions;
      
      const versionInfo = versions.find(v => v.id === options.mcVersion);
      if (!versionInfo) {
        throw new Error(`Minecraft version ${options.mcVersion} not found`);
      }
      
      // Get version details
      const versionDetailsResponse = await axios.get(versionInfo.url);
      const clientDownloadUrl = versionDetailsResponse.data.downloads.client.url;
      
      // Download the client jar
      const clientJarPath = path.join(options.clientPath, 'client.jar');
      
      this.mainWindow.webContents.send('minecraft-client-progress', {
        percent: 0,
        speed: 'Starting...',
        fileName: 'minecraft-client.jar'
      });

      await this.downloadFile(clientDownloadUrl, clientJarPath, {
        onProgress: (progress) => {
          this.mainWindow.webContents.send('minecraft-client-progress', {
            percent: progress.percent,
            speed: progress.speed,
            fileName: 'minecraft-client.jar'
          });
        }
      });
      
      this.mainWindow.webContents.send('install-log', 'Minecraft client downloaded successfully');
      return true;
    } catch (error) {
      console.error('Error downloading Minecraft client:', error);
      this.mainWindow.webContents.send('install-log', `Error downloading Minecraft client: ${error.message}`);
      return false;
    }
  }

  /**
   * Download Fabric loader for the client
   * @param {Object} options - Download options
   * @param {string} options.clientPath - Path to download client to
   * @param {string} options.mcVersion - Minecraft version
   * @param {string} options.fabricVersion - Fabric loader version
   * @returns {Promise<boolean>} Success status
   */
  async downloadFabricLoader(options) {
    try {
      if (!options.clientPath || !options.mcVersion || !options.fabricVersion) {
        throw new Error('Missing required parameters');
      }

      // Create the Fabric directory if it doesn't exist
      const fabricDir = path.join(options.clientPath, 'fabric');
      await this.ensureDirectoryExists(fabricDir);
      
      // Get Fabric installer URL
      const fabricInstallerUrl = `https://maven.fabricmc.net/net/fabricmc/fabric-installer/0.11.2/fabric-installer-0.11.2.jar`;
      const installerPath = path.join(fabricDir, 'fabric-installer.jar');
      
      this.mainWindow.webContents.send('fabric-install-progress', {
        percent: 0,
        speed: 'Starting...',
        fileName: 'fabric-installer.jar'
      });

      // Download the installer
      await this.downloadFile(fabricInstallerUrl, installerPath, {
        onProgress: (progress) => {
          this.mainWindow.webContents.send('fabric-install-progress', {
            percent: progress.percent,
            speed: progress.speed,
            fileName: 'fabric-installer.jar'
          });
        }
      });
      
      // Save configuration for the client
      const configPath = path.join(options.clientPath, 'client-config.json');
      const config = {
        minecraftVersion: options.mcVersion,
        fabricVersion: options.fabricVersion,
        lastUpdated: new Date().toISOString()
      };
      
      fs.writeFileSync(configPath, JSON.stringify(config, null, 2));
      
      this.mainWindow.webContents.send('install-log', 'Fabric loader installation prepared');
      return true;
    } catch (error) {
      console.error('Error downloading Fabric loader:', error);
      this.mainWindow.webContents.send('install-log', `Error downloading Fabric loader: ${error.message}`);
      return false;
    }
  }

  /**
   * Download mods from server to client
   * @param {Object} options - Download options
   * @param {string} options.clientPath - Path to download mods to
   * @param {string} options.serverPath - Path to server mods
   * @param {Array<string>} options.requiredMods - List of mod filenames required by the server
   * @returns {Promise<boolean>} Success status
   */
  async downloadRequiredMods(options) {
    try {
      if (!options.clientPath || !options.serverPath || !options.requiredMods) {
        throw new Error('Missing required parameters');
      }

      // Create the mods directory if it doesn't exist
      const modsDir = path.join(options.clientPath, 'mods');
      await this.ensureDirectoryExists(modsDir);
      
      const totalMods = options.requiredMods.length;
      let completedMods = 0;
      
      // Copy each mod from server to client
      for (const modFile of options.requiredMods) {
        const sourcePath = path.join(options.serverPath, 'mods', modFile);
        const destPath = path.join(modsDir, modFile);
        
        // Skip if mod file doesn't exist on the server
        if (!fs.existsSync(sourcePath)) {
          this.mainWindow.webContents.send('install-log', `Warning: Mod ${modFile} not found on server`);
          continue;
        }
        
        // Copy the mod file
        fs.copyFileSync(sourcePath, destPath);
        completedMods++;
        
        // Update progress
        const percent = Math.round((completedMods / totalMods) * 100);
        this.mainWindow.webContents.send('minecraft-client-progress', {
          percent,
          speed: `${completedMods}/${totalMods} mods`,
          fileName: modFile
        });
        
        this.mainWindow.webContents.send('install-log', `Copied mod: ${modFile}`);
      }
      
      this.mainWindow.webContents.send('install-log', `Mods download completed. ${completedMods}/${totalMods} mods installed`);
      return true;
    } catch (error) {
      console.error('Error downloading mods:', error);
      this.mainWindow.webContents.send('install-log', `Error downloading mods: ${error.message}`);
      return false;
    }
  }

  async updateForServerVersion(options) {
    const { clientPath, mcVersion, fabricVersion, requiredMods = [], allClientMods = [], serverPath = null } = options;
    const configPath = path.join(clientPath, 'client-config.json');
    let current = {};
    if (fs.existsSync(configPath)) {
      try { current = JSON.parse(fs.readFileSync(configPath, 'utf8')); } catch {}
    }

    if (mcVersion && mcVersion !== current.minecraftVersion) {
      await this.downloadMinecraftClient({ clientPath, mcVersion });
      current.minecraftVersion = mcVersion;
    }

    if (fabricVersion && fabricVersion !== current.fabricVersion) {
      await this.downloadFabricLoader({ clientPath, mcVersion, fabricVersion });
      current.fabricVersion = fabricVersion;
    }

    if (requiredMods.length > 0 && serverPath) {
      await this.downloadRequiredMods({ clientPath, serverPath, requiredMods });
    }

    // Clean up obsolete mods
    if (allClientMods.length > 0) {
      const modsDir = path.join(clientPath, 'mods');
      if (fs.existsSync(modsDir)) {
        const allowed = new Set(allClientMods.map(m => typeof m === 'string' ? m : m.fileName));
        const files = fs.readdirSync(modsDir).filter(f => f.endsWith('.jar'));
        for (const file of files) {
          if (!allowed.has(file)) {
            try { fs.unlinkSync(path.join(modsDir, file)); } catch {}
          }
        }
      }
    }

    fs.writeFileSync(configPath, JSON.stringify({
      minecraftVersion: current.minecraftVersion,
      fabricVersion: current.fabricVersion,
      lastUpdated: new Date().toISOString()
    }, null, 2));

    return true;
  }

  /**
   * Ensure a directory exists
   * @param {string} dir - Directory path
   */
  async ensureDirectoryExists(dir) {
    if (!fs.existsSync(dir)) {
      await mkdir(dir, { recursive: true });
    }
  }

  /**
   * Download a file with progress tracking
   * @param {string} url - URL to download from
   * @param {string} destination - Path to save file to
   * @param {Object} options - Download options
   * @param {Function} options.onProgress - Progress callback
   */
  async downloadFile(url, destination, options = {}) {
    const { onProgress } = options;
    let downloadedSize = 0;
    let totalSize = 0;
    let startTime = Date.now();
    
    const response = await axios({
      url,
      method: 'GET',
      responseType: 'stream'
    });
    
    totalSize = parseInt(response.headers['content-length'], 10);
    
    return new Promise((resolve, reject) => {
      const writer = createWriteStream(destination);
      
      response.data.on('data', (chunk) => {
        downloadedSize += chunk.length;
        
        if (onProgress) {
          const elapsedSeconds = (Date.now() - startTime) / 1000;
          const speedMBps = ((downloadedSize / elapsedSeconds) / (1024 * 1024)).toFixed(2);
          const percent = Math.round((downloadedSize / totalSize) * 100);
          
          onProgress({
            percent,
            speed: `${speedMBps} MB/s`,
            downloaded: downloadedSize,
            total: totalSize
          });
        }
      });
      
      response.data.pipe(writer);
      
      writer.on('finish', resolve);
      writer.on('error', reject);
    });
  }
}

module.exports = ClientDownloadManager; 
