const fs = require('fs');
const path = require('path');
const axios = require('axios');
const { createWriteStream } = require('fs');
const { mkdir } = require('fs/promises');
const { app, BrowserWindow, ipcMain } = require('electron'); // Added ipcMain

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
      const { clientPath, mcVersion } = options;
      console.log(`[ClientDownloadManager] Downloading Minecraft client ${mcVersion}...`);

      // Use the existing client downloader from minecraft-launcher
      const ClientDownloader = require('./minecraft-launcher/client-downloader.cjs');
      const JavaManager = require('./minecraft-launcher/java-manager.cjs');
      const { EventEmitter } = require('events');

      const eventEmitter = new EventEmitter();
      const javaManager = new JavaManager();
      const clientDownloader = new ClientDownloader(javaManager, eventEmitter);

      const result = await clientDownloader.downloadMinecraftClientSimple(clientPath, mcVersion);
      
      if (result.success) {
        console.log(`[ClientDownloadManager] Successfully downloaded Minecraft ${mcVersion}`);
        return true;
      } else {
        throw new Error(result.error || 'Failed to download Minecraft client');
      }
    } catch (error) {
      console.error(`[ClientDownloadManager] Error downloading Minecraft client:`, error);
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
      const { clientPath, mcVersion, fabricVersion } = options;
      console.log(`[ClientDownloadManager] Installing Fabric loader ${fabricVersion} for Minecraft ${mcVersion}...`);

      // Use the existing client downloader from minecraft-launcher
      const ClientDownloader = require('./minecraft-launcher/client-downloader.cjs');
      const JavaManager = require('./minecraft-launcher/java-manager.cjs');
      const { EventEmitter } = require('events');

      const eventEmitter = new EventEmitter();
      const javaManager = new JavaManager();
      const clientDownloader = new ClientDownloader(javaManager, eventEmitter);

      const result = await clientDownloader.installFabricLoader(clientPath, mcVersion, fabricVersion);
      
      if (result.success) {
        console.log(`[ClientDownloadManager] Successfully installed Fabric ${fabricVersion}`);
        return true;
      } else {
        throw new Error(result.error || 'Failed to install Fabric loader');
      }
    } catch (error) {
      console.error(`[ClientDownloadManager] Error installing Fabric loader:`, error);
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
      const { clientPath, serverPath, requiredMods } = options;
      console.log(`[ClientDownloadManager] Downloading ${requiredMods.length} required mods...`);

      const modsDir = path.join(clientPath, 'mods');
      await this.ensureDirectoryExists(modsDir);

      // Copy mods from server to client
      for (const mod of requiredMods) {
        try {
          const modFileName = typeof mod === 'string' ? mod : (mod.fileName || mod.name);
          const serverModPath = path.join(serverPath, 'mods', modFileName);
          const clientModPath = path.join(modsDir, modFileName);

          if (fs.existsSync(serverModPath)) {
            // Copy mod from server to client
            const modData = fs.readFileSync(serverModPath);
            fs.writeFileSync(clientModPath, modData);
            console.log(`[ClientDownloadManager] Copied mod: ${modFileName}`);
          } else {
            console.warn(`[ClientDownloadManager] Server mod not found: ${modFileName}`);
          }
        } catch (modError) {
          console.error(`[ClientDownloadManager] Error copying mod ${mod}:`, modError);
        }
      }

      console.log(`[ClientDownloadManager] Successfully downloaded required mods`);
      return true;
    } catch (error) {
      console.error(`[ClientDownloadManager] Error downloading required mods:`, error);
      return false;
    }
  }

  /**
   * Update client components for the server version
   * @param {Object} options - Update options
   * @param {string} options.clientPath - Path to client directory
   * @param {string} options.mcVersion - Minecraft version
   * @param {string} options.fabricVersion - Fabric version
   * @param {Array} options.requiredMods - List of required mods
   * @param {Array} options.allClientMods - List of all client mods
   * @param {string} options.serverPath - Path to server directory (for mod download)
   * @returns {Promise<boolean>} Success status
   */
  async updateForServerVersion(options) {
    const { clientPath, mcVersion, fabricVersion, requiredMods = [], allClientMods = [], serverPath = null } = options;
    const configPath = path.join(clientPath, 'client-config.json');
    let current = {};
    if (fs.existsSync(configPath)) {
      try { current = JSON.parse(fs.readFileSync(configPath, 'utf8')); } catch {}
    }
    const actualOldMinecraftVersion = current.minecraftVersion; // Capture the true old version

    // Clean up old versions before installing new ones
    if (mcVersion && mcVersion !== actualOldMinecraftVersion) {
      if (actualOldMinecraftVersion) {
        console.log(`[ClientDownloadManager] Cleaning up old Minecraft version: ${actualOldMinecraftVersion}`);
        await this.cleanupOldVersion(clientPath, actualOldMinecraftVersion, current.fabricVersion);
      }
      
      // Check client-side mod compatibility with new Minecraft version
      if (actualOldMinecraftVersion) { // Ensure there was an old version to compare against
        console.log(`[ClientDownloadManager] Invoking client-side mod compatibility check. New MC: ${mcVersion}, Old MC: ${actualOldMinecraftVersion}`);
        try {
          const serverManagedFileNames = (allClientMods || []) // Use allClientMods
            .map(mod => (typeof mod === 'string' ? mod : mod.fileName || mod.name))
            .filter(Boolean);

          // Invoke the IPC handler. It will send the report to the renderer.
          await ipcMain.invoke('check-client-mod-compatibility', {
            clientPath: clientPath,
            newMinecraftVersion: mcVersion,
            oldMinecraftVersion: actualOldMinecraftVersion,
            serverManagedFiles: serverManagedFileNames
          });
          // The 'client-mod-compatibility-report' event is sent by the invoked IPC handler.
        } catch (ipcError) {
          console.error(`[ClientDownloadManager] Error invoking client mod compatibility check via IPC:`, ipcError);
          // Don't fail the entire update process if compatibility check fails
        }
      }
      
      await this.downloadMinecraftClient({ clientPath, mcVersion });
      current.minecraftVersion = mcVersion;
    }

    if (fabricVersion && fabricVersion !== current.fabricVersion) {
      if (current.fabricVersion && current.minecraftVersion) {
        console.log(`[ClientDownloadManager] Cleaning up old Fabric version: ${current.fabricVersion}`);
        await this.cleanupOldFabricProfile(clientPath, current.minecraftVersion, current.fabricVersion);
      }
      await this.downloadFabricLoader({ clientPath, mcVersion, fabricVersion });
      current.fabricVersion = fabricVersion;
    }    if (requiredMods.length > 0 && serverPath) {
      await this.downloadRequiredMods({ clientPath, serverPath, requiredMods });
    }

    // Improved mod cleanup that preserves manual mods
    // Always run cleanup to detect and preserve manual mods, even if no allClientMods provided
    await this.cleanupObsoleteMods(clientPath, allClientMods || []);

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

  /**
   * Clean up old Minecraft version directories
   * @param {string} clientPath - Path to client directory
   * @param {string} oldVersion - Old Minecraft version to clean up
   * @param {string} oldFabricVersion - Old Fabric version (if any)
   */
  async cleanupOldVersion(clientPath, oldVersion, oldFabricVersion) {
    try {
      console.log(`[ClientDownloadManager] Cleaning up old Minecraft version: ${oldVersion}`);
      
      const versionsDir = path.join(clientPath, 'versions');
      if (!fs.existsSync(versionsDir)) return;

      // Remove vanilla version directory
      const oldVersionDir = path.join(versionsDir, oldVersion);
      if (fs.existsSync(oldVersionDir)) {
        fs.rmSync(oldVersionDir, { recursive: true, force: true });
        console.log(`[ClientDownloadManager] Removed old vanilla version directory: ${oldVersion}`);
      }

      // Remove old Fabric profile if it existed
      if (oldFabricVersion) {
        const oldFabricProfile = `fabric-loader-${oldFabricVersion}-${oldVersion}`;
        const oldFabricDir = path.join(versionsDir, oldFabricProfile);
        if (fs.existsSync(oldFabricDir)) {
          fs.rmSync(oldFabricDir, { recursive: true, force: true });
          console.log(`[ClientDownloadManager] Removed old Fabric profile directory: ${oldFabricProfile}`);
        }
      }

      // Clean up orphaned library directories (optional, conservative approach)
      const librariesDir = path.join(clientPath, 'libraries');
      if (fs.existsSync(librariesDir)) {
        try {
          // Only remove obviously old version-specific libraries, keep shared ones
          const versionSpecificPaths = [
            path.join(librariesDir, 'net', 'minecraft'),
            path.join(librariesDir, 'net', 'fabricmc', 'fabric-loader', oldFabricVersion || ''),
          ].filter(p => p && fs.existsSync(p));

          for (const libPath of versionSpecificPaths) {
            if (fs.existsSync(libPath)) {
              fs.rmSync(libPath, { recursive: true, force: true });
              console.log(`[ClientDownloadManager] Cleaned up old library: ${path.relative(librariesDir, libPath)}`);
            }
          }
        } catch (libCleanupError) {
          console.warn(`[ClientDownloadManager] Could not clean up some libraries: ${libCleanupError.message}`);
        }
      }

    } catch (error) {
      console.error(`[ClientDownloadManager] Error cleaning up old version ${oldVersion}:`, error);
    }
  }

  /**
   * Clean up old Fabric profile directories
   * @param {string} clientPath - Path to client directory
   * @param {string} mcVersion - Minecraft version
   * @param {string} oldFabricVersion - Old Fabric version to clean up
   */
  async cleanupOldFabricProfile(clientPath, mcVersion, oldFabricVersion) {
    try {
      console.log(`[ClientDownloadManager] Cleaning up old Fabric profile: ${oldFabricVersion}`);
      
      const versionsDir = path.join(clientPath, 'versions');
      if (!fs.existsSync(versionsDir)) return;

      // Remove old Fabric profile directory
      const oldFabricProfile = `fabric-loader-${oldFabricVersion}-${mcVersion}`;
      const oldFabricDir = path.join(versionsDir, oldFabricProfile);
      if (fs.existsSync(oldFabricDir)) {
        fs.rmSync(oldFabricDir, { recursive: true, force: true });
        console.log(`[ClientDownloadManager] Removed old Fabric profile: ${oldFabricProfile}`);
      }

      // Clean up old Fabric-specific libraries
      const librariesDir = path.join(clientPath, 'libraries');
      if (fs.existsSync(librariesDir)) {
        try {
          const fabricLibPath = path.join(librariesDir, 'net', 'fabricmc', 'fabric-loader', oldFabricVersion);
          if (fs.existsSync(fabricLibPath)) {
            fs.rmSync(fabricLibPath, { recursive: true, force: true });
            console.log(`[ClientDownloadManager] Cleaned up old Fabric libraries: ${oldFabricVersion}`);
          }
        } catch (libCleanupError) {
          console.warn(`[ClientDownloadManager] Could not clean up Fabric libraries: ${libCleanupError.message}`);
        }
      }

    } catch (error) {
      console.error(`[ClientDownloadManager] Error cleaning up old Fabric profile ${oldFabricVersion}:`, error);
    }
  }
  /**
   * Smart mod cleanup that preserves manual mods and shows warnings for incompatible ones
   * @param {string} clientPath - Path to client directory
   * @param {Array} allClientMods - List of server-required mods (can be empty)
   */
  async cleanupObsoleteMods(clientPath, allClientMods = []) {
    try {
      console.log(`[ClientDownloadManager] Starting smart mod cleanup...`);
      
      const modsDir = path.join(clientPath, 'mods');
      if (!fs.existsSync(modsDir)) {
        console.log(`[ClientDownloadManager] Mods directory doesn't exist, nothing to clean up`);
        return;
      }

      const existingMods = fs.readdirSync(modsDir).filter(file => 
        file.endsWith('.jar') || file.endsWith('.zip')
      );

      if (existingMods.length === 0) {
        console.log(`[ClientDownloadManager] No existing mods found`);
        return;
      }

      // Create set of required mod filenames for quick lookup
      const requiredModNames = new Set(allClientMods.map(mod => {
        if (typeof mod === 'string') return mod;
        if (mod.fileName) return mod.fileName;
        if (mod.name) return mod.name;
        return null;
      }).filter(Boolean));

      const manualMods = [];
      const obsoleteMods = [];      // Analyze each existing mod
      for (const modFile of existingMods) {
        // Check if this mod is in the required list (only if we have a specific list)
        const isRequired = allClientMods.length > 0 && (
          requiredModNames.has(modFile) || 
          requiredModNames.has(path.parse(modFile).name) ||
          Array.from(requiredModNames).some(reqMod => {
            const reqName = path.parse(reqMod).name.toLowerCase();
            const currentName = path.parse(modFile).name.toLowerCase();
            return reqName === currentName || currentName.includes(reqName) || reqMod.includes(currentName);
          })
        );

        if (!isRequired) {
          // Check if this looks like a manual mod by trying to detect mod metadata
          const modPath = path.join(modsDir, modFile);
          const isManual = await this.detectManualMod(modPath);
          
          if (isManual) {
            manualMods.push(modFile);
          } else {
            // Only remove if we have a specific list of required mods and this isn't one of them
            if (allClientMods.length > 0) {
              obsoleteMods.push(modFile);
            } else {
              // If no specific mod list provided, treat as manual to be safe
              manualMods.push(modFile);
            }
          }
        }
      }

      // Remove only clearly obsolete mods (non-manual, non-required)
      for (const obsoleteMod of obsoleteMods) {
        try {
          const modPath = path.join(modsDir, obsoleteMod);
          fs.unlinkSync(modPath);
          console.log(`[ClientDownloadManager] Removed obsolete mod: ${obsoleteMod}`);
        } catch (error) {
          console.warn(`[ClientDownloadManager] Could not remove obsolete mod ${obsoleteMod}: ${error.message}`);
        }
      }

      // Log manual mods that were preserved
      if (manualMods.length > 0) {
        console.log(`[ClientDownloadManager] Preserved ${manualMods.length} manual mods:`);
        manualMods.forEach(mod => console.log(`  - ${mod}`));
        
        // Save manual mods list for UI to show warnings
        const manualModsConfig = path.join(clientPath, 'manual-mods.json');
        fs.writeFileSync(manualModsConfig, JSON.stringify({
          manualMods: manualMods,
          lastUpdated: new Date().toISOString(),
          warning: "These mods were manually installed and may not be compatible with the current server version. Please check mod compatibility and remove incompatible mods if needed."
        }, null, 2));
      }

      console.log(`[ClientDownloadManager] Smart mod cleanup completed. Removed ${obsoleteMods.length} obsolete mods, preserved ${manualMods.length} manual mods`);

    } catch (error) {
      console.error(`[ClientDownloadManager] Error during smart mod cleanup:`, error);
    }
  }

  /**
   * Detect if a mod was manually installed by checking its metadata
   * @param {string} modPath - Path to the mod file
   * @returns {Promise<boolean>} True if the mod appears to be manually installed
   */
  async detectManualMod(modPath) {
    try {
      // Check if mod has custom metadata indicating manual installation
      const modFileManager = require('../ipc/mod-utils/mod-file-manager.cjs');
      
      // Try to read mod metadata
      const modInfo = await this.getModMetadata(modPath);
        // Heuristics for detecting manual mods:
      // 1. Mods with names matching common client-side mods
      // 2. Mods that are typically user-installed (performance, UI, etc.)
      // 3. Check file timestamps and metadata for manual installation indicators
      
      const fileName = path.basename(modPath).toLowerCase();
      const modStat = fs.statSync(modPath);
      
      if (modInfo) {
        const modName = modInfo.name?.toLowerCase() || '';
        
        // Common client-side/manual mods - these are typically NOT server mods
        const clientSideModPatterns = [
          'optifine', 'optifabric', 'iris', 'sodium', 'lithium', 'phosphor',
          'mod-menu', 'roughly-enough-items', 'rei', 'jei', 'nei', 'waila', 'hwyla',
          'journeymap', 'xaeros', 'minimap', 'inventory-tweaks', 'mouse-tweaks',
          'controlling', 'configured', 'catalogue', 'custom', 'client', 'gui',
          'hud', 'overlay', 'performance', 'optimization', 'fps', 'graphics'
        ];
        
        const isCommonClientMod = clientSideModPatterns.some(pattern => 
          modName.includes(pattern) || fileName.includes(pattern)
        );
        
        if (isCommonClientMod) {
          return true;
        }
        
        // Check if mod has client-side indicators in metadata
        if (modInfo.environment === 'client' || modInfo.side === 'client') {
          return true;
        }
      }
      
      // Check file age - if mod was modified very recently (within last few minutes),
      // it's likely part of a server download. If it's older, more likely manual.
      const ageMinutes = (Date.now() - modStat.mtime.getTime()) / (1000 * 60);
      if (ageMinutes > 10) { // More than 10 minutes old
        console.log(`[ClientDownloadManager] Mod ${fileName} is ${Math.round(ageMinutes)} minutes old, likely manual`);
        return true;
      }
      
      // For unknown mods that are recent, treat as potentially server-managed
      console.log(`[ClientDownloadManager] Mod ${fileName} is recent (${Math.round(ageMinutes)} min), treating as server-managed`);
      return false;
        } catch (error) {
      // If we can't analyze the mod, check file age as fallback
      try {
        const fileName = path.basename(modPath).toLowerCase();
        const modStat = fs.statSync(modPath);
        const ageMinutes = (Date.now() - modStat.mtime.getTime()) / (1000 * 60);
        
        console.warn(`[ClientDownloadManager] Could not analyze mod ${fileName}, using age-based detection: ${Math.round(ageMinutes)} min old`);
        
        // If file is older than 10 minutes, likely manual
        return ageMinutes > 10;
      } catch (statError) {
        console.warn(`[ClientDownloadManager] Could not analyze mod ${modPath}, treating as manual: ${error.message}`);
        return true; // Default to manual if we can't determine anything
      }
    }
  }

  /**
   * Get basic metadata from a mod file
   * @param {string} modPath - Path to the mod file
   * @returns {Promise<Object|null>} Mod metadata or null if not readable
   */
  async getModMetadata(modPath) {
    try {
      const AdmZip = require('adm-zip');
      const zip = new AdmZip(modPath);
      
      // Try to read fabric.mod.json (Fabric mods)
      const fabricModEntry = zip.getEntry('fabric.mod.json');
      if (fabricModEntry) {
        const fabricMod = JSON.parse(fabricModEntry.getData().toString('utf8'));
        return {
          name: fabricMod.name || fabricMod.id,
          version: fabricMod.version,
          type: 'fabric'
        };
      }
      
      // Try to read META-INF/mods.toml (Forge mods)
      const forgeModEntry = zip.getEntry('META-INF/mods.toml');
      if (forgeModEntry) {
        const tomlContent = forgeModEntry.getData().toString('utf8');
        const nameMatch = tomlContent.match(/displayName\s*=\s*"([^"]+)"/);
        const versionMatch = tomlContent.match(/version\s*=\s*"([^"]+)"/);
        return {
          name: nameMatch ? nameMatch[1] : null,
          version: versionMatch ? versionMatch[1] : null,
          type: 'forge'
        };
      }
      
      // Try to read mcmod.info (Legacy Forge mods)
      const legacyModEntry = zip.getEntry('mcmod.info');
      if (legacyModEntry) {
        const mcmodInfo = JSON.parse(legacyModEntry.getData().toString('utf8'));
        const modInfo = Array.isArray(mcmodInfo) ? mcmodInfo[0] : mcmodInfo;
        return {
          name: modInfo.name,
          version: modInfo.version,
          type: 'forge-legacy'
        };
      }
      
      return null;
  } catch (error) {
      return null;
    }
  }

  /**
   * Check client-side mod compatibility with a new Minecraft version
   * @param {string} clientPath - Path to the client directory
   * @param {string} newMinecraftVersion - The new Minecraft version
   * @returns {Promise<Object>} - Compatibility report
   */
  async checkClientModCompatibility(clientPath, newMinecraftVersion) {
    try {
      console.log(`[ClientDownloadManager] Checking client mod compatibility for Minecraft ${newMinecraftVersion}`);
      
      const modsDir = path.join(clientPath, 'mods');
      if (!fs.existsSync(modsDir)) {
        return {
          compatible: [],
          incompatible: [],
          needsUpdate: [],
          unknown: [],
          errors: [],
          hasIncompatible: false,
          hasUpdatable: false
        };
      }
      
      const files = fs.readdirSync(modsDir);
      const jarFiles = files.filter(file => file.endsWith('.jar'));
      
      const compatibilityResults = [];
      
      for (const fileName of jarFiles) {
        try {
          const modPath = path.join(modsDir, fileName);
          const metadata = await this.extractModMetadata(modPath);
          
          let compatibilityStatus = 'unknown';
          let reason = '';
          let availableUpdate = null;
          
          if (metadata && metadata.gameVersions) {
            // Check if mod supports the new Minecraft version
            const isCompatible = metadata.gameVersions.includes(newMinecraftVersion);
            
            if (isCompatible) {
              compatibilityStatus = 'compatible';
            } else {
              compatibilityStatus = 'incompatible';
              reason = `Does not support Minecraft ${newMinecraftVersion}. Supported versions: ${metadata.gameVersions.join(', ')}`;
            }
          } else {
            // Fallback to filename-based checking
            const filenameCheck = this.checkModCompatibilityFromFilename(fileName, newMinecraftVersion);
            if (filenameCheck.isCompatible) {
              compatibilityStatus = 'compatible';
              reason = 'Compatibility determined from filename';
            } else {
              compatibilityStatus = 'unknown';
              reason = 'Unable to determine compatibility - manual verification recommended';
            }
          }
          
          compatibilityResults.push({
            fileName,
            name: metadata?.name || fileName,
            compatibilityStatus,
            reason,
            availableUpdate,
            metadata
          });
          
        } catch (modError) {
          console.error(`[ClientDownloadManager] Error checking compatibility for ${fileName}:`, modError);
          compatibilityResults.push({
            fileName,
            name: fileName,
            compatibilityStatus: 'error',
            reason: `Error checking compatibility: ${modError.message}`
          });
        }
      }
      
      // Categorize results
      const report = {
        compatible: compatibilityResults.filter(r => r.compatibilityStatus === 'compatible'),
        incompatible: compatibilityResults.filter(r => r.compatibilityStatus === 'incompatible'),
        needsUpdate: compatibilityResults.filter(r => r.compatibilityStatus === 'needs_update'),
        unknown: compatibilityResults.filter(r => r.compatibilityStatus === 'unknown'),
        errors: compatibilityResults.filter(r => r.compatibilityStatus === 'error'),
        hasIncompatible: false,
        hasUpdatable: false
      };
      
      report.hasIncompatible = report.incompatible.length > 0;
      report.hasUpdatable = report.needsUpdate.length > 0;
      
      console.log(`[ClientDownloadManager] Compatibility check complete:`, {
        total: compatibilityResults.length,
        compatible: report.compatible.length,
        incompatible: report.incompatible.length,
        needsUpdate: report.needsUpdate.length,
        unknown: report.unknown.length,
        errors: report.errors.length
      });
      
      return report;
      
    } catch (error) {
      console.error(`[ClientDownloadManager] Error checking client mod compatibility:`, error);
      throw new Error(`Failed to check client mod compatibility: ${error.message}`);
    }
  }

  /**
   * Check mod compatibility based on filename
   * @param {string} filename - The mod filename
   * @param {string} minecraftVersion - Target Minecraft version
   * @returns {Object} - Compatibility result
   */
  checkModCompatibilityFromFilename(filename, minecraftVersion) {
    if (!filename || !minecraftVersion) {
      return { isCompatible: false, confidence: 'low' };
    }
    
    const lowerFilename = filename.toLowerCase();
    const versionPattern = /(\d+\.\d+(?:\.\d+)?)/g;
    const matches = lowerFilename.match(versionPattern);
    
    if (!matches) {
      return { isCompatible: false, confidence: 'low' };
    }
    
    // Check if the target Minecraft version appears in the filename
    for (const match of matches) {
      if (match === minecraftVersion || minecraftVersion.startsWith(match)) {
        return { isCompatible: true, confidence: 'medium' };
      }
    }
    
    return { isCompatible: false, confidence: 'medium' };
  }

}

module.exports = ClientDownloadManager;
