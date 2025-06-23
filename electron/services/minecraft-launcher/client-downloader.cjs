const fs = require('fs');
const path = require('path');
const https = require('https');
const { spawn } = require('child_process');
const fetch = require('node-fetch');
const utils = require('./utils.cjs');

class ClientDownloader {
  constructor(javaManager, eventEmitter) {
    this.javaManager = javaManager;
    this.emitter = eventEmitter;
  }

  async _resolveFabricLoaderVersion(requestedVersion) {
    // If already a fabric profile name, extract the version part
    if (requestedVersion && requestedVersion.startsWith('fabric-loader-')) {
      const parts = requestedVersion.split('-');
      if (parts.length >= 3) {
        // Extract loader version from fabric-loader-X.Y.Z-MC_VERSION format
        return parts[2]; // This should be the loader version (e.g., 0.16.14)
      }
    }
    
    if (requestedVersion === 'latest') {
      try {
        const response = await fetch('https://meta.fabricmc.net/v2/versions/loader');
        const loaders = await response.json();
        if (loaders && loaders.length > 0 && loaders[0].version) {
          return loaders[0].version;
        }
        return '0.14.21'; // Fallback
      } catch {
        return '0.14.21'; // Fallback
      }
    }
    
    return requestedVersion;
  }

  async downloadMinecraftClientSimple(clientPath, minecraftVersion, options = {}) {
    
    this.emitter.emit('client-download-start', { version: minecraftVersion });
    
    const { 
      requiredMods = [], 
      serverInfo = null 
    } = options;
    
    let needsFabric = serverInfo?.loaderType === 'fabric' || requiredMods.length > 0;
    let requestedFabricVersion = serverInfo?.loaderVersion || 'latest';
    let resolvedFabricVersion = requestedFabricVersion;
    
    const maxRetries = 2; 
    let retryCount = 0;
    
    while (retryCount < maxRetries) {
      try {
        
        if (retryCount > 0) {
          await new Promise(resolve => setTimeout(resolve, 10000));
        }
        
        if (global.gc) {
          global.gc();
          await new Promise(resolve => setTimeout(resolve, 2000));
        }
        
        const requiredJavaVersion = utils.getRequiredJavaVersion(minecraftVersion);
        
        this.emitter.emit('client-download-progress', {
          type: 'Java',
          task: `Checking Java ${requiredJavaVersion}...`,
          total: 1
        });
        
        const javaResult = await this.javaManager.ensureJava(requiredJavaVersion, (progress) => {
          this.emitter.emit('client-download-progress', {
            type: progress.type,
            task: progress.task,
            total: progress.totalMB || 0,
            current: progress.downloadedMB || 0
          });
        });
        
        if (!javaResult.success) {
          throw new Error(`Failed to obtain Java ${requiredJavaVersion}: ${javaResult.error}`);
        }
        
        
        const essentialDirs = ['versions', 'libraries', 'assets', 'mods'];
        for (const dir of essentialDirs) {
          const dirPath = path.join(clientPath, dir);
          if (!fs.existsSync(dirPath)) {
            fs.mkdirSync(dirPath, { recursive: true });
          }
        }
        
        this.emitter.emit('client-download-progress', {
          type: 'Preparing',
          task: 'Setting up download process...',
          total: 1
        });
        
        this.emitter.emit('client-download-progress', {
          type: 'Downloading',
          task: 'Downloading Minecraft version, libraries, and assets...',
          total: 3
        });
        
        let downloadSuccess = false;

        try {
          downloadSuccess = await this.downloadMinecraftManually(clientPath, minecraftVersion);
        } catch {
          downloadSuccess = false;
        }
        
        if (!downloadSuccess) {
          throw new Error('All download methods failed. Please check your internet connection and try again.');
        }
        
        this.emitter.emit('client-download-progress', {
          type: 'Verifying',
          task: 'Verifying downloaded files...',
          total: 4
        });
        
        await new Promise(resolve => setTimeout(resolve, 8000));
        
        if (global.gc) {
          global.gc();
          await new Promise(resolve => setTimeout(resolve, 2000));
        }
        
        const versionsDir = path.join(clientPath, 'versions');
        const versionDir = path.join(versionsDir, minecraftVersion);
        const jarFile = path.join(versionDir, `${minecraftVersion}.jar`);
        
        
        if (fs.existsSync(jarFile)) {
          const jarStats = fs.statSync(jarFile);
          if (jarStats.size === 0) {
            throw new Error('Download failed: Minecraft JAR file is empty. This usually indicates a network connectivity issue or the download was interrupted.');
          }
        }
        
        const vanillaVerificationResult = await this.checkMinecraftClient(clientPath, minecraftVersion);
        if (!vanillaVerificationResult.synchronized) {
          throw new Error(`Vanilla client download verification failed: ${vanillaVerificationResult.reason}`);
        }
        
        let finalVersion = minecraftVersion;
        let fabricProfileName = null;
        
        if (needsFabric) {
          this.emitter.emit('client-download-progress', {
            type: 'Fabric',
            task: `Installing Fabric loader ${requestedFabricVersion}...`, // Show requested version
            total: 5
          });
          try {
            const fabricResult = await this.installFabricLoader(clientPath, minecraftVersion, requestedFabricVersion);
            if (fabricResult.success) {
              fabricProfileName = fabricResult.profileName;
              finalVersion = fabricProfileName;
              resolvedFabricVersion = fabricResult.loaderVersion;
              this.emitter.emit('client-download-progress', {
                type: 'Fabric',
                task: `Fabric ${resolvedFabricVersion} installed successfully`,
                total: 5
              });
            } else {
              throw new Error(`Fabric installation failed: ${fabricResult.error}`);
            }
          } catch (fabricError) {
            const hasRequiredMods = requiredMods && requiredMods.length > 0;
            
            if (hasRequiredMods) {
              throw new Error(`Cannot install Fabric for required mods: ${fabricError.message}`);
            } else {
              needsFabric = false;
              finalVersion = minecraftVersion;
              this.emitter.emit('client-download-progress', {
                type: 'Warning',
                task: 'Fabric installation failed, using vanilla Minecraft',
                total: 5
              });
            }
          }
        }
        
        // Download assets for both Fabric and Vanilla
        this.emitter.emit('client-download-progress', {
          type: 'Assets',
          task: 'Downloading game assets...',
          total: 5
        });
        
        try {
          const assetResult = await this.downloadAssets(clientPath, minecraftVersion);
          if (assetResult.success) {
            this.emitter.emit('client-download-progress', {
              type: 'Assets',
              task: `Assets downloaded successfully (${assetResult.total} files)`,
              total: 5
            });
          }
          // Removed empty else block
        } catch { // _assetError unused, catch effectively empty (L193)
          // Don't fail the entire process for asset errors, but warn
        }
        
        // NEW: Add server to Minecraft server list if server info is provided
        const serverInfo = options.serverInfo;
        
        const hasServerInfo = serverInfo && (
          serverInfo.minecraftPort ||
          serverInfo.port ||
          (serverInfo.serverInfo && serverInfo.serverInfo.port) ||
          serverInfo.ip ||
          serverInfo.serverIp
        );
        
        
        if (hasServerInfo) {
          
          this.emitter.emit('client-download-progress', {
            type: 'Server',
            task: 'Adding server to multiplayer list...',
            total: 6
          });
          
          try {
            const serverResult = await this.addServerToList(clientPath, serverInfo);
            
            if (!serverResult.success) {
              // Optional: log if server adding failed but not critical enough to stop
            }
          } catch {
            // Optional: log if server adding threw an error
          }
        }
        
        const finalVerificationOptions = needsFabric ? { requiredMods, serverInfo } : {};
        const finalVerificationResult = await this.checkMinecraftClient(clientPath, minecraftVersion, finalVerificationOptions);
          if (finalVerificationResult.synchronized) {
          const clientType = needsFabric ? `Fabric ${resolvedFabricVersion}` : 'Vanilla'; // Use resolved version
          const finalMessage = `Successfully downloaded Minecraft ${minecraftVersion} (${clientType}) with Java ${requiredJavaVersion} and all required libraries and assets.`;
          
          // Automatic cleanup of old versions
          this.emitter.emit('client-download-progress', {
            type: 'Cleanup',
            task: '🗑️ Cleaning up old versions...',
            total: 100,
            current: 100
          });

          const cleanupResult = await this.cleanupOldVersions(clientPath, minecraftVersion, needsFabric ? resolvedFabricVersion : null);
          if (cleanupResult.success) {
            console.log(`✅ Cleanup completed: ${cleanupResult.message}`);
          } else {
            console.warn(`⚠️ Cleanup warning: ${cleanupResult.error}`);
          }
          
          this.emitter.emit('client-download-complete', { 
            success: true, 
            version: finalVersion,
            vanillaVersion: minecraftVersion,
            fabricVersion: needsFabric ? resolvedFabricVersion : null, // Use resolved version
            fabricProfileName: fabricProfileName,
            message: finalMessage,
            cleanup: cleanupResult
          });
          return { 
            success: true, 
            version: finalVersion,
            vanillaVersion: minecraftVersion,
            fabricVersion: needsFabric ? resolvedFabricVersion : null, // Use resolved version
            fabricProfileName: fabricProfileName,
            message: finalMessage
          };
        } else {
          throw new Error(`Final verification failed: ${finalVerificationResult.reason}`);
        }
      } catch (error) {
        if ((error.code === 'EMFILE' || error.message.includes('too many open files')) && retryCount < maxRetries - 1) {
          if (global.gc) {
            global.gc();
          }
          retryCount++;
          continue;
        }

        let userMessage = error.message; // Default to original error message
        const knownErrorMessages = {
          EMFILE: 'System file limit reached during download. Please close other applications, restart the application, and try again.',
          ENOTFOUND_MSG: 'Cannot connect to Minecraft download servers. Please check your internet connection.',
          TIMEOUT_MSG: 'Download timed out. Please try again with a better internet connection.'
        };

        if (error.code === 'EMFILE' || (error.message && error.message.includes('too many open files'))) {
          userMessage = knownErrorMessages.EMFILE;
        } else if (error.message && error.message.includes('ENOTFOUND')) {
          userMessage = knownErrorMessages.ENOTFOUND_MSG;
        } else if (error.message && error.message.includes('timeout')) {
          userMessage = knownErrorMessages.TIMEOUT_MSG;
        }

        this.emitter.emit('client-download-error', { 
          error: userMessage,
          version: minecraftVersion 
        });
        return { success: false, error: userMessage };
      }
    }
  }

  async downloadMinecraftManually(clientPath, minecraftVersion) {
    const versionsDir = path.join(clientPath, 'versions');
    const versionDir = path.join(versionsDir, minecraftVersion);
      const librariesDir = path.join(clientPath, 'libraries');
      const assetsDir = path.join(clientPath, 'assets');
      
      if (!fs.existsSync(versionsDir)) fs.mkdirSync(versionsDir, { recursive: true });
      if (!fs.existsSync(versionDir)) fs.mkdirSync(versionDir, { recursive: true });
      if (!fs.existsSync(librariesDir)) fs.mkdirSync(librariesDir, { recursive: true });
      if (!fs.existsSync(assetsDir)) fs.mkdirSync(assetsDir, { recursive: true });

      // Phase 1: Get version manifest
      this.emitter.emit('client-download-progress', {
        type: 'Preparing',
        task: 'Fetching version manifest...',
        total: 1,
        current: 0
      });
      
      const manifestResponse = await fetch('https://piston-meta.mojang.com/mc/game/version_manifest_v2.json');
      const manifest = await manifestResponse.json();
      
      const versionInfo = manifest.versions.find(v => v.id === minecraftVersion);
      if (!versionInfo) {
        throw new Error(`Version ${minecraftVersion} not found`);
      }

      // Phase 2: Get version details
      this.emitter.emit('client-download-progress', {
        type: 'Preparing',
        task: 'Getting version details...',
        total: 1,
        current: 0.3
      });
      
      const versionDetails = await this.downloadJson(versionInfo.url);
      
      const versionJsonPath = path.join(versionDir, `${minecraftVersion}.json`);
      fs.writeFileSync(versionJsonPath, JSON.stringify(versionDetails, null, 2));
      
      // Phase 3: Download Minecraft JAR
      this.emitter.emit('client-download-progress', {
        type: 'Client JAR',
        task: `Downloading Minecraft ${minecraftVersion} client...`,
        total: 1,
        current: 0
      });

      const clientJarPath = path.join(versionDir, `${minecraftVersion}.jar`);
      const expectedJarSize = versionDetails.downloads.client.size;
      
      if (fs.existsSync(clientJarPath)) {
        fs.unlinkSync(clientJarPath);
      }
      
      const jarDownloadSuccess = await this._downloadFileSingle(
        versionDetails.downloads.client.url, 
        clientJarPath,
        (progress) => {
          this.emitter.emit('client-download-progress', {
            type: 'Client JAR',
            task: `Downloading Minecraft ${minecraftVersion} client... ${Math.round(progress)}%`,
            total: Math.round(expectedJarSize / (1024 * 1024)), // MB
            current: Math.round((progress / 100) * expectedJarSize / (1024 * 1024)) // MB
          });
        }
      );
      
      if (!jarDownloadSuccess) {
        throw new Error('Failed to download Minecraft client JAR');
      }
      

      // Phase 4: Download Libraries
      this.emitter.emit('client-download-progress', {
        type: 'Libraries',
        task: 'Preparing to download libraries...',
        total: 1,
        current: 0
      });

      const libraries = versionDetails.libraries || [];
      const downloadableLibraries = libraries.filter(lib => {
        if (lib.rules) {
          for (const rule of lib.rules) {
            if (rule.action === 'disallow' && rule.os && rule.os.name === 'windows') {
              return false;
            }
          }
        }
        return lib.downloads && lib.downloads.artifact;
      });

      for (let i = 0; i < downloadableLibraries.length; i++) {
        const lib = downloadableLibraries[i];
        
        this.emitter.emit('client-download-progress', {
          type: 'Libraries',
          task: `Downloading library ${i + 1} of ${downloadableLibraries.length}...`,
          total: downloadableLibraries.length,
          current: i
        });

        if (lib.rules) {
          let shouldSkip = false;
          for (const rule of lib.rules) {
            if (rule.action === 'disallow' && rule.os && rule.os.name === 'windows') {
              shouldSkip = true;
              break;
            }
          }
          if (shouldSkip) continue;
        }

        if (lib.downloads && lib.downloads.artifact) {
          const artifact = lib.downloads.artifact;
          const libPath = path.join(clientPath, 'libraries', artifact.path);
              const libDir = path.dirname(libPath);
          
              if (!fs.existsSync(libDir)) {
                fs.mkdirSync(libDir, { recursive: true });
              }

          await this._downloadFileSingle(artifact.url, libPath);
        }
      }

      this.emitter.emit('client-download-progress', {
        type: 'Assets',
        task: 'Setting up game assets...',
        total: 1,
        current: 0
      });
      
      const assetsIndexesDir = path.join(assetsDir, 'indexes');
      if (!fs.existsSync(assetsIndexesDir)) {
        fs.mkdirSync(assetsIndexesDir, { recursive: true });
      }
      
      if (versionDetails.assetIndex) {
        const assetIndexUrl = versionDetails.assetIndex.url;
        const assetIndexPath = path.join(assetsIndexesDir, `${versionDetails.assetIndex.id}.json`);
        
        await this._downloadFileSingle(assetIndexUrl, assetIndexPath);

        const assetIndexData = JSON.parse(fs.readFileSync(assetIndexPath, 'utf8'));
        
        if (assetIndexData.objects) {
          for (const assetData of Object.values(assetIndexData.objects)) {
            const hash = assetData.hash;
            const subPath = hash.substring(0, 2);
            assetData.url = `https://resources.download.minecraft.net/${subPath}/${hash}`;
          }
        }
        
        fs.writeFileSync(assetIndexPath, JSON.stringify(assetIndexData, null, 2));
      }

      // Final completion
      this.emitter.emit('client-download-progress', {
        type: 'Complete',
        task: 'Download completed successfully!',
        total: 1,
        current: 1
      });


      
      return true;
  }

  async downloadJson(url, maxRetries = 3) {
    for (let attempt = 1; attempt <= maxRetries; attempt++) {
      try {
        return await this._downloadJsonSingle(url);
      } catch (error) {
        if (attempt === maxRetries) {
          throw new Error(`Failed to download JSON from ${url} after ${maxRetries} attempts: ${error.message}`);
        }
        await new Promise(resolve => setTimeout(resolve, attempt * 1000));
      }
    }
  }

  async _downloadJsonSingle(url) {
    return new Promise((resolve, reject) => {
      const timeout = 15000;
      const request = https.get(url, { timeout }, (response) => {
        if (response.statusCode >= 300 && response.statusCode < 400 && response.headers.location) {
          return this._downloadJsonSingle(response.headers.location).then(resolve, reject);
        }
        if (response.statusCode !== 200) {
          return reject(new Error(`HTTP ${response.statusCode}: ${response.statusMessage}`));
        }
        let data = '';
        response.on('data', (chunk) => data += chunk);
        response.on('end', () => {
          try {
            resolve(JSON.parse(data));
          } catch (parseError) {
            reject(new Error(`Invalid JSON response: ${parseError.message}`));
          }
        });
        response.on('error', reject);
      });
      request.on('timeout', () => {
        request.destroy();
        reject(new Error('JSON download timeout'));
      });
      request.on('error', reject);
    });
  }

  async downloadFile(url, filePath, maxRetries = 3, progressCallback = null) {
    for (let attempt = 1; attempt <= maxRetries; attempt++) {
      try {
        await this._downloadFileSingle(url, filePath, progressCallback);
        return;
      } catch (error) {
        if (attempt === maxRetries) {
          throw new Error(`Failed to download ${url} after ${maxRetries} attempts: ${error.message}`);
        }
        await new Promise(resolve => setTimeout(resolve, attempt * 1000));
      }
    }
  }

  async _downloadFileSingle(url, filePath, progressCallback = null) {
    return new Promise((resolve, reject) => {
      const file = fs.createWriteStream(filePath);
      const timeout = 60000;
      let downloadedBytes = 0;
      let totalBytes = 0;
      let lastProgressUpdate = 0;
      
      const request = https.get(url, { timeout }, (response) => {
        if (response.statusCode >= 300 && response.statusCode < 400 && response.headers.location) {
          file.close();
          fs.unlink(filePath, () => {});
          return this._downloadFileSingle(response.headers.location, filePath, progressCallback).then(resolve, reject);
        }
        if (response.statusCode !== 200) {
          file.close();
          fs.unlink(filePath, () => {});
          return reject(new Error(`HTTP ${response.statusCode}: ${response.statusMessage}`));
        }
        totalBytes = parseInt(response.headers['content-length'] || '0', 10);
        
        response.on('data', (chunk) => {
          downloadedBytes += chunk.length;
            // Call progress callback if provided (but not too frequently)
          if (progressCallback && totalBytes > 0) {
            const progress = Math.round((downloadedBytes / totalBytes) * 100 * 100) / 100; // Round to 2 decimal places
            const now = Date.now();
            if (now - lastProgressUpdate > 500) { // Update every 500ms
              progressCallback(progress);
              lastProgressUpdate = now;
            }
          }
        });
        
        response.pipe(file);
      });

      request.on('error', (err) => {
        file.close();
          fs.unlink(filePath, () => {});
        reject(err);
        });

      request.on('timeout', () => {
        file.close();
        fs.unlink(filePath, () => {});
        reject(new Error('Download timeout'));
      });

      file.on('finish', () => {
        const finalSize = fs.statSync(filePath).size;
        
        if (totalBytes > 0 && finalSize !== totalBytes) {
        fs.unlink(filePath, () => {});
          return reject(new Error(`Download incomplete: ${finalSize}/${totalBytes} bytes`));
        }
        
        resolve(true);
      });

      file.on('error', (err) => {
        fs.unlink(filePath, () => {});
        reject(err);
      });
    });
  }

  async installFabricLoader(clientPath, minecraftVersion, fabricVersion = 'latest') {
    try {
      const fabricInstallerUrl = 'https://maven.fabricmc.net/net/fabricmc/fabric-installer/0.11.2/fabric-installer-0.11.2.jar';
      const installerPath = path.join(clientPath, 'fabric-installer.jar');
      if (!fs.existsSync(installerPath)) {
        const response = await fetch(fabricInstallerUrl);
        if (!response.ok) {
          throw new Error(`Failed to download Fabric installer: ${response.status}`);
        }
        const fileStream = fs.createWriteStream(installerPath);
        response.body.pipe(fileStream);
        await new Promise((resolve, reject) => {
          fileStream.on('finish', () => resolve());
          fileStream.on('error', reject);
        });
      }
      // Resolve the loader version using the new helper method
      const actualLoaderVersion = await this._resolveFabricLoaderVersion(fabricVersion); // fabricVersion is the parameter
      const fabricProfileName = `fabric-loader-${actualLoaderVersion}-${minecraftVersion}`;
      const versionsDir = path.join(clientPath, 'versions');
      const fabricProfileDir = path.join(versionsDir, fabricProfileName);
      
      const fabricJsonPath = path.join(fabricProfileDir, `${fabricProfileName}.json`);
      const fabricJarPath = path.join(fabricProfileDir, `${fabricProfileName}.jar`);
      
      if (fs.existsSync(fabricProfileDir) && fs.existsSync(fabricJsonPath) && fs.existsSync(fabricJarPath)) {
        const jarStats = fs.statSync(fabricJarPath);
        if (jarStats.size > 0) {
        return { success: true, profileName: fabricProfileName };
        } else {
          fs.rmSync(fabricProfileDir, { recursive: true, force: true });
      }
      }
      
      const requiredJavaVersion = utils.getRequiredJavaVersion(minecraftVersion);
      let javaResult;
      try {
        javaResult = await this.javaManager.ensureJava(requiredJavaVersion);
        if (!javaResult.success) {
          throw new Error(`Failed to obtain Java ${requiredJavaVersion} for Fabric installation: ${javaResult.error}`);
        }
      } catch (javaError) {
        throw new Error(`Java not available for Fabric installation: ${javaError.message}`);
      }
      const javaExe = javaResult.javaPath;
      
      const launcherProfilesPath = path.join(clientPath, 'launcher_profiles.json');
      if (!fs.existsSync(launcherProfilesPath)) {
        const launcherProfiles = {
          "profiles": {
            "latest": {
              "name": "Latest Release",
              "type": "latest-release",
              "created": new Date().toISOString(),
              "lastUsed": new Date().toISOString(),
              "icon": "Furnace",
              "lastVersionId": "latest-release",
              "gameDir": clientPath
            }
          },
          "settings": {
            "enableSnapshots": false,
            "enableAdvanced": false,
            "keepLauncherOpen": false,
            "showGameLog": false,
            "showMenu": false
          },
          "analyticsToken": "",
          "clientToken": "",
          "launcherVersion": {
            "format": 21,
            "name": "custom"
          }
        };
        fs.writeFileSync(launcherProfilesPath, JSON.stringify(launcherProfiles, null, 2));
      }
      
      const installerArgs = [
        '-jar', installerPath,
        'client',
        '-mcversion', minecraftVersion,
        '-loader', actualLoaderVersion, // Use actualLoaderVersion
        '-dir', clientPath
      ];
      const installer = spawn(javaExe, installerArgs, {
        cwd: clientPath,
        stdio: ['ignore', 'pipe', 'pipe']
      });
      let installerOutput = '';
      installer.stdout.on('data', (data) => {
        const output = data.toString();
        installerOutput += output;
      });
      installer.stderr.on('data', (data) => {
        const output = data.toString();
        installerOutput += output;
      });
      const exitCode = await new Promise((resolve) => {
        installer.on('close', resolve);
      });
      if (exitCode !== 0) {
        throw new Error(`Fabric installer failed with exit code ${exitCode}: ${installerOutput}`);
      }
      
      if (!fs.existsSync(fabricProfileDir)) {
        throw new Error(`Fabric profile directory not created: ${fabricProfileDir}`);
      }
      if (!fs.existsSync(fabricJsonPath)) {
        throw new Error(`Fabric profile JSON not created: ${fabricJsonPath}`);
      }
      
      let jarStats = null;
      let needsJarRecreation = false;
      
      if (!fs.existsSync(fabricJarPath)) {
        needsJarRecreation = true;
      } else {
        jarStats = fs.statSync(fabricJarPath);
        if (jarStats.size === 0) {
          needsJarRecreation = true;
        }
      }
      
      if (needsJarRecreation) {
        await this.createFabricProfileJar(fabricJarPath, actualLoaderVersion, minecraftVersion); // Use actualLoaderVersion
        
        // Verify the manually created JAR
        if (fs.existsSync(fabricJarPath)) {
          jarStats = fs.statSync(fabricJarPath);
        } else {
          throw new Error(`Failed to create Fabric profile JAR: ${fabricJarPath}`);
        }
      }
      
      // Final verification
      if (!jarStats) {
        jarStats = fs.statSync(fabricJarPath);
      }
      if (jarStats.size === 0) {
        throw new Error(`Fabric profile JAR is still empty after recreation: ${fabricJarPath}`);
      }
      
      
      await this.enrichFabricJson(clientPath, fabricProfileName);
      
      try {
        const fabricJson = JSON.parse(fs.readFileSync(fabricJsonPath, 'utf8'));
        const vanillaJsonPath = path.join(clientPath, 'versions', minecraftVersion, `${minecraftVersion}.json`);
        
        if (fs.existsSync(vanillaJsonPath)) {
          const vanillaJson = JSON.parse(fs.readFileSync(vanillaJsonPath, 'utf8'));
          let modified = false;
          
          // Ensure Fabric profile has vanilla downloads.client for MCLC classpath
          if (!fabricJson.downloads?.client && vanillaJson.downloads?.client) {
            fabricJson.downloads = fabricJson.downloads || {};
            fabricJson.downloads.client = vanillaJson.downloads.client;
            modified = true;
          }
          
          // Merge vanilla libraries into Fabric profile to prevent missing library errors
          if (vanillaJson.libraries && Array.isArray(vanillaJson.libraries) && vanillaJson.libraries.length > 0) {
            
            // Initialize Fabric libraries array if it doesn't exist
            fabricJson.libraries = fabricJson.libraries || [];
            
            // Create a set of existing Fabric library names to avoid duplicates
            const existingFabricLibs = new Set(fabricJson.libraries.map(lib => lib.name).filter(Boolean));
            
            // Function to detect ASM libraries that should be skipped to avoid conflicts
            const skipASM = lib => {
              if (!lib.name) return false;
              // Skip ASM libraries since Fabric provides its own version
              return /^org\.ow2\.asm:asm(?:-|$)/.test(lib.name);
            };
            
            // Filter vanilla libraries to exclude ASM and duplicates, but include ALL others
            const vanillaLibsToMerge = vanillaJson.libraries.filter(lib => {
              // Must have a name
              if (!lib.name) return false;
              
              // Skip ASM libraries to prevent conflicts
              if (skipASM(lib)) {
                return false;
              }
              
              // Skip if already exists in Fabric profile
              if (existingFabricLibs.has(lib.name)) {
                return false;
              }
              
              // Include everything else
              return true;
            });
            
            if (vanillaLibsToMerge.length > 0) {
              // Merge vanilla libraries at the front of the array for priority
              fabricJson.libraries = [...vanillaLibsToMerge, ...fabricJson.libraries];
              
              // Verify critical libraries are present
              const criticalLibraries = [
                'net.sf.jopt-simple:jopt-simple',
                'com.mojang:brigadier',
                'com.mojang:authlib', 
                'com.mojang:datafixerupper',
                'com.google.guava:guava'
              ];
              
              const missingCritical = [];              criticalLibraries.forEach(requiredLib => {
                const found = fabricJson.libraries.find(lib => lib.name?.startsWith(requiredLib));
                if (!found) {
                  missingCritical.push(requiredLib);
                }
              });
              
              modified = true;
            } // Removed empty "else {}" block.
          } // Removed empty "else {}" block.
          
          // Add inheritsFrom field to link to vanilla
          if (!fabricJson.inheritsFrom) {
            fabricJson.inheritsFrom = minecraftVersion;
            modified = true;
          }
          
          // Ensure Fabric profile inherits essential properties from vanilla
          if (!fabricJson.assetIndex && vanillaJson.assetIndex) {
            fabricJson.assetIndex = vanillaJson.assetIndex;
            modified = true;
          }
          
          // Set mainClass to Fabric's knot client
          if (!fabricJson.mainClass) {
            fabricJson.mainClass = 'net.fabricmc.loader.impl.launch.knot.KnotClient';
            modified = true;
          }
          
          // Ensure Fabric profile can locate the vanilla JAR
          if (!fabricJson.jar && vanillaJson.jar) {
            fabricJson.jar = vanillaJson.jar;
            modified = true;
          }          
          // Fix asset index to use vanilla version instead of MCLC's "24" index
          if (fabricJson.assetIndex?.id === "24" || !fabricJson.assetIndex) {
            if (vanillaJson.assetIndex) {
              fabricJson.assetIndex = vanillaJson.assetIndex;
              modified = true;
            }
          }
          
          // Fix auth placeholders to use camelCase format
          if (fabricJson.arguments?.game) {
            let authFixed = false;
            const gameArgs = fabricJson.arguments.game;
            
            for (let i = 0; i < gameArgs.length; i++) {
              const arg = gameArgs[i];
              if (typeof arg === 'string') {
                // Fix snake_case auth placeholders to camelCase
                const fixes = {
                  '${auth_player_name}': '${auth_playerName}',
                  '${auth_access_token}': '${auth_accessToken}',
                  '${auth_user_type}': '${auth_userType}',
                  '${auth_session}': '${auth_session}' // This one stays the same
                };
                
                let newArg = arg;
                for (const [oldPlaceholder, newPlaceholder] of Object.entries(fixes)) {
                  if (newArg.includes(oldPlaceholder)) {
                    newArg = newArg.replace(oldPlaceholder, newPlaceholder);
                    authFixed = true;
                  }
                }
                
                if (newArg !== arg) {
                  gameArgs[i] = newArg;
                }
              }
            }
            
            if (authFixed) {
              modified = true;
            }
          }          
          // Fix incorrect downloads.client URL to use vanilla's version
          if (fabricJson.downloads?.client) {
            const clientUrl = fabricJson.downloads.client.url;
            // If downloads.client doesn't match vanilla, use vanilla's version
            if (vanillaJson.downloads?.client && clientUrl !== vanillaJson.downloads.client.url) {
              fabricJson.downloads.client = vanillaJson.downloads.client;
              modified = true;
            }
          }
          
          // Ensure type is set correctly
          if (!fabricJson.type) {
            fabricJson.type = vanillaJson.type || "release";
            modified = true;
          }
          
          // Ensure time and releaseTime exist
          if (!fabricJson.time && vanillaJson.time) {
            fabricJson.time = vanillaJson.time;
            modified = true;
          }
          if (!fabricJson.releaseTime && vanillaJson.releaseTime) {
            fabricJson.releaseTime = vanillaJson.releaseTime;
            modified = true;
          }
          
          if (modified) {
            fs.writeFileSync(fabricJsonPath, JSON.stringify(fabricJson, null, 2));
          } // Removed empty "else {}" block.
        } // Removed empty "else {}" block.
      } catch { // _fabricFixError unused, removing try/catch as per L930
        // console.error('Error fixing Fabric JSON:', _fabricFixError); // Optional logging
      }
      
      try {
        fs.unlinkSync(installerPath);
      } catch { // _cleanupError unused, removing try/catch as per L956
        // console.warn('Error cleaning up Fabric installer:', _cleanupError); // Optional logging
      }
      return { 
        success: true, 
        profileName: fabricProfileName,
        loaderVersion: actualLoaderVersion // Return the resolved loader version
      };
    } catch (error) {
      return { 
        success: false, 
        error: error.message 
      };
    }
  }

  // Create Fabric profile JAR manually if installer fails
  async createFabricProfileJar(fabricJarPath, loaderVersion, minecraftVersion) {
    try {
      
      const manifest = `Manifest-Version: 1.0
Main-Class: net.fabricmc.loader.impl.launch.knot.KnotClient
Implementation-Title: Fabric Loader
Implementation-Version: ${loaderVersion}
Implementation-Vendor: FabricMC
Specification-Title: Fabric Loader
Specification-Version: ${loaderVersion}
Specification-Vendor: FabricMC

`;
      
      const AdmZip = require('adm-zip').default;
              const zip = new (/** @type {any} */ (AdmZip))();
      
      zip.addFile('META-INF/MANIFEST.MF', Buffer.from(manifest, 'utf8'));
      
      const fabricModJson = {
        "schemaVersion": 1,
        "id": `fabric-loader-${loaderVersion}-${minecraftVersion}`,
        "version": loaderVersion,
        "name": "Fabric Loader Profile",
        "environment": "*",
        "entrypoints": {},
        "depends": {
          "fabricloader": `>=${loaderVersion}`,
          "minecraft": minecraftVersion
        }
      };
      
      zip.addFile('fabric.mod.json', Buffer.from(JSON.stringify(fabricModJson, null, 2), 'utf8'));
      
      // Write the JAR file
      zip.writeZip(fabricJarPath, (e) => {
        if (e) throw e;
      });
      
      
    } catch { // _error unused (L999), catch block has fallback logic
      
      const manifestFallback = `Manifest-Version: 1.0\r\nMain-Class: net.fabricmc.loader.impl.launch.knot.KnotClient\r\n\r\n`;
      const manifestBuffer = Buffer.from(manifestFallback, 'utf8');
      
      const localFileHeader = Buffer.alloc(30 + 20 + manifestBuffer.length);
      const centralDirHeader = Buffer.alloc(46 + 20);
      const endOfCentralDir = Buffer.alloc(22);
      
      localFileHeader.writeUInt32LE(0x04034b50, 0);
      localFileHeader.writeUInt16LE(20, 4);
      localFileHeader.writeUInt16LE(0, 6);
      localFileHeader.writeUInt16LE(0, 8); // Compression method (stored)
      localFileHeader.writeUInt16LE(0, 10); // File last modification time
      localFileHeader.writeUInt16LE(0, 12); // File last modification date
      localFileHeader.writeUInt32LE(0, 14); // CRC-32 (0 for stored)
      localFileHeader.writeUInt32LE(manifestBuffer.length, 18); // Compressed size
      localFileHeader.writeUInt32LE(manifestBuffer.length, 22); // Uncompressed size
      localFileHeader.writeUInt16LE(20, 26); // Filename length
      localFileHeader.writeUInt16LE(0, 28); // Extra field length
      localFileHeader.write('META-INF/MANIFEST.MF', 30, 'ascii'); // Filename
      manifestBuffer.copy(localFileHeader, 50); // File content
      
      // Central directory file header
      centralDirHeader.writeUInt32LE(0x02014b50, 0); // Central directory signature
      centralDirHeader.writeUInt16LE(20, 4); // Version made by
      centralDirHeader.writeUInt16LE(20, 6); // Version needed to extract
      centralDirHeader.writeUInt16LE(0, 8); // General purpose bit flag
      centralDirHeader.writeUInt16LE(0, 10); // Compression method
      centralDirHeader.writeUInt16LE(0, 12); // File last modification time
      centralDirHeader.writeUInt16LE(0, 14); // File last modification date
      centralDirHeader.writeUInt32LE(0, 16); // CRC-32
      centralDirHeader.writeUInt32LE(manifestBuffer.length, 20); // Compressed size
      centralDirHeader.writeUInt32LE(manifestBuffer.length, 24); // Uncompressed size
      centralDirHeader.writeUInt16LE(20, 28); // Filename length
      centralDirHeader.writeUInt16LE(0, 30); // Extra field length
      centralDirHeader.writeUInt16LE(0, 32); // File comment length
      centralDirHeader.writeUInt16LE(0, 34); // Disk number start
      centralDirHeader.writeUInt16LE(0, 36); // Internal file attributes
      centralDirHeader.writeUInt32LE(0, 38); // External file attributes
      centralDirHeader.writeUInt32LE(0, 42); // Relative offset of local header
      centralDirHeader.write('META-INF/MANIFEST.MF', 46, 'ascii'); // Filename
      
      // End of central directory record
      endOfCentralDir.writeUInt32LE(0x06054b50, 0); // End of central directory signature
      endOfCentralDir.writeUInt16LE(0, 4); // Disk number
      endOfCentralDir.writeUInt16LE(0, 6); // Disk number with central directory
      endOfCentralDir.writeUInt16LE(1, 8); // Number of central directory records on this disk
      endOfCentralDir.writeUInt16LE(1, 10); // Total number of central directory records
      endOfCentralDir.writeUInt32LE(centralDirHeader.length, 12); // Size of central directory
      endOfCentralDir.writeUInt32LE(localFileHeader.length, 16); // Offset of start of central directory
      endOfCentralDir.writeUInt16LE(0, 20); // Comment length
      
      // Write the complete ZIP file
      const zipBuffer = Buffer.concat([localFileHeader, centralDirHeader, endOfCentralDir]);
      fs.writeFileSync(fabricJarPath, zipBuffer);
      
    }
  }

  async addServerToList(clientPath, rawServerInfo) {
    try {

      // === 1. Normalize keys ===
      const nested = rawServerInfo.serverInfo || {};
      const flat = {
        name: nested.name  || rawServerInfo.name   || 'Minecraft Server',
        ip:   nested.ip    || rawServerInfo.ip     || rawServerInfo.serverIp || 'localhost',
        port: parseInt(nested.port 
                 || rawServerInfo.minecraftPort 
                 || rawServerInfo.port 
                 || '25565', 10)
      };

      // === 2. Ensure clientPath exists ===
      if (!fs.existsSync(clientPath)) {
        fs.mkdirSync(clientPath, { recursive: true });
      }
      
      // === 3. Update options.txt → lastServer:ip:port ===
      try {
        const optionsFile = path.join(clientPath, 'options.txt');

        let optionsContent = '';
        if (fs.existsSync(optionsFile)) {
          optionsContent = fs.readFileSync(optionsFile, 'utf8');
        }

        // Remove any existing lastServer line, then re-append
        const lines = optionsContent.split('\n').filter(line => !line.startsWith('lastServer:'));
        const serverAddress = (flat.port === 25565) ? flat.ip : `${flat.ip}:${flat.port}`;
        lines.push(`lastServer:${serverAddress}`);
        fs.writeFileSync(optionsFile, lines.join('\n'), 'utf8');
      } catch { // _err unused, empty catch block, removing try/catch (L1118)
      }

      // === 4. Write a **valid** servers.dat NBT file ===
      try {
        
      const nbt = require('prismarine-nbt');
        const zlib = require('zlib');
        
        const serversDatPath = path.join(clientPath, 'servers.dat');
        
        let existingServers = [];

        // Read existing servers if file exists
        if (fs.existsSync(serversDatPath)) {
          try {
            const existingBuffer = fs.readFileSync(serversDatPath);
            
            const uncompressed = zlib.gunzipSync(existingBuffer);            const parsedNbt = await nbt.parse(uncompressed);
            
            // Extract existing server entries - Fixed NBT path
            if (parsedNbt && parsedNbt.parsed && parsedNbt.parsed.value && parsedNbt.parsed.value.servers) {
              const serversTag = parsedNbt.parsed.value.servers;
              if (serversTag.type === 'list' && Array.isArray(serversTag.value)) {
                const serverCompoundTags = serversTag.value;

                existingServers = serverCompoundTags.map(serverCompound => {
                  // serverCompound should have .value containing the server data
                  const serverData = serverCompound.value || {};
                  return {
                    name: serverData.name?.value || 'Minecraft Server',
                    ip: serverData.ip?.value || 'localhost',
                    icon: serverData.icon?.value || '',
                    acceptTextures: serverData.acceptTextures?.value || 0
                  };
                });
              } else {
                existingServers = [];
              }
            } else {
              existingServers = [];
            }

            // Filter out any duplicate of our new server AFTER mapping to plain objects
            const targetIpPort = `${flat.ip}:${flat.port}`;
            existingServers = existingServers.filter(server => server.ip !== targetIpPort);
            
          } catch { // _parseError unused (L1164), but existingServers is set.
            existingServers = [];
          }
          // Removed empty "else {}" block for "if (fs.existsSync(serversDatPath))".
        }

        // Create new server entry (simple object)
        const newServerEntry = {
          name: flat.name,
          ip: `${flat.ip}:${flat.port}`,
          icon: '',
          acceptTextures: 1
        };

        // Add our new server to the list
        existingServers.push(newServerEntry);        // Build NBT structure using prismarine-nbt helper functions (correct approach)
        const nbtServers = existingServers.map(server => ({
          name: nbt.string(server.name || 'Minecraft Server'),
          ip: nbt.string(server.ip || 'localhost'),
          icon: nbt.string(server.icon || ''),
          acceptTextures: nbt.byte(server.acceptTextures === 1 ? 1 : 0)
        }));

        const nbtData = nbt.comp({
          servers: nbt.list(nbt.comp(nbtServers))
        });
        
        const rawBuffer = nbt.writeUncompressed(/** @type {any} */(nbtData));
        
        // Compress the NBT data since Minecraft expects gzip-compressed servers.dat
        const compressedBuffer = zlib.gzipSync(rawBuffer);
        
        // Write to file
        fs.writeFileSync(serversDatPath, compressedBuffer);
        
      } catch (nbtErr) {
        return {
          success: false,
          method: 'nbt',
          error: nbtErr.message,
          message: 'Failed to write valid servers.dat; server was not added automatically.'
        };
      }

      // === 5. Return success ===
      return {
        success: true,
        method: 'nbt',
        serverData: flat,
        message: `Server "${flat.name}" added to Minecraft multiplayer list automatically.`
      };

    } catch (error) {
      return {
        success: false,
        error: error.message,
        message: 'Failed to add server to multiplayer list'
      };
    }
  }

  async checkMinecraftClient(clientPath, requiredVersion, options = {}) {
    try {
      this.javaManager.setClientPath(clientPath); // Set clientPath for JavaManager
      if (!fs.existsSync(clientPath)) {
        return { synchronized: false, reason: 'Client path does not exist' };
      }
      
      // Check if version has changed since last check
      const versionChangeDetected = await this._checkForVersionChange(clientPath, requiredVersion);
      if (versionChangeDetected) {
        // Clean up old versions when server version changes
        await this._cleanupOldVersionsOnChange(clientPath, requiredVersion);
      }
      
      const { 
        requiredMods = [], 
        serverInfo = null 
      } = options;
      let needsFabric = serverInfo?.loaderType === 'fabric' || requiredMods.length > 0;
      let initialFabricVersion = serverInfo?.loaderVersion || 'latest'; // Keep original request for clarity if needed elsewhere
      let resolvedFabricVersion = initialFabricVersion;
      let targetVersion = requiredVersion;
      let fabricProfileName = null;

      if (needsFabric) {
        resolvedFabricVersion = await this._resolveFabricLoaderVersion(initialFabricVersion);
        fabricProfileName = `fabric-loader-${resolvedFabricVersion}-${requiredVersion}`;
        targetVersion = fabricProfileName;
      }
      const requiredJavaVersion = utils.getRequiredJavaVersion(requiredVersion); // Use imported utils
      if (!this.javaManager.isJavaInstalled(requiredJavaVersion)) {
        return { 
          synchronized: false, 
          reason: `Java ${requiredJavaVersion} is required for Minecraft ${requiredVersion} but is not installed`,
          needsJava: true,
          requiredJavaVersion: requiredJavaVersion
        };
      }
      const versionsDir = path.join(clientPath, 'versions');
      const librariesDir = path.join(clientPath, 'libraries');
      const assetsDir = path.join(clientPath, 'assets');
      let jarFile, jsonFile, versionDir;
      if (needsFabric) {
        versionDir = path.join(versionsDir, targetVersion);
        jsonFile = path.join(versionDir, `${targetVersion}.json`);
        const vanillaVersionDir = path.join(versionsDir, requiredVersion);
        jarFile = path.join(vanillaVersionDir, `${requiredVersion}.jar`);
      } else {
        versionDir = path.join(versionsDir, targetVersion);
        jarFile = path.join(versionDir, `${targetVersion}.jar`);
        jsonFile = path.join(versionDir, `${targetVersion}.json`);
      }
      if (!fs.existsSync(versionDir)) {
        if (needsFabric) {
          return { 
            synchronized: false, 
            reason: `Fabric profile ${fabricProfileName} not installed`,
            needsFabric: true,
            fabricVersion: resolvedFabricVersion, // Use resolvedFabricVersion
            vanillaVersion: requiredVersion
          };
        } else {
          return { synchronized: false, reason: `Version ${requiredVersion} not downloaded` };
        }
      }
      if (!fs.existsSync(jarFile)) {
        return { synchronized: false, reason: needsFabric ? `Vanilla JAR missing for Fabric profile (${requiredVersion})` : `Client JAR missing for ${requiredVersion}` };
      }
      if (!fs.existsSync(jsonFile)) {
        return { synchronized: false, reason: needsFabric ? `Fabric profile manifest missing (${fabricProfileName})` : `Version manifest missing for ${requiredVersion}` };
      }
      const jarStats = fs.statSync(jarFile);
      const jsonStats = fs.statSync(jsonFile);
      // Reduced logging - only show size info
      if (jarStats.size === 0) {
        return { synchronized: false, reason: needsFabric ? `Vanilla JAR file is corrupted (empty) - required for Fabric` : `Client JAR file is corrupted (empty)` };
      }
      if (jsonStats.size === 0) {
        return { synchronized: false, reason: needsFabric ? `Fabric profile manifest is corrupted (empty)` : `Version manifest is corrupted (empty)` };
      }
      // Minimal logging for directory checks
      if (!fs.existsSync(librariesDir) || fs.readdirSync(librariesDir).length === 0) {
        return { synchronized: false, reason: 'Client libraries not downloaded or empty' };
      }
      const assetsIndexesDir = path.join(assetsDir, 'indexes');
      if (!fs.existsSync(assetsDir) || !fs.existsSync(assetsIndexesDir) || fs.readdirSync(assetsIndexesDir).length === 0) {
        return { synchronized: false, reason: 'Client assets not downloaded or indexes empty' };
      }
      const resultMessage = needsFabric 
        ? `All client files, Fabric ${resolvedFabricVersion}, and Java ${requiredJavaVersion} are present and verified`
        : `All client files and Java ${requiredJavaVersion} are present and verified`;
      return { 
        synchronized: true, 
        reason: resultMessage,
        javaVersion: requiredJavaVersion,
        needsFabric: needsFabric,
        fabricVersion: needsFabric ? resolvedFabricVersion : null, // Use resolved version
        fabricProfileName: fabricProfileName,
        targetVersion: targetVersion
      };
    } catch (error) {
      return { synchronized: false, reason: 'Error checking client files: ' + error.message };
    }
  }

  async enrichFabricJson(clientPath, fabricProfileName) {
    // Enhanced post-processing of Fabric JSON to add complete download metadata
    const versionsDir = path.join(clientPath, 'versions');
    const jsonPath = path.join(versionsDir, fabricProfileName, `${fabricProfileName}.json`);
    
    if (!fs.existsSync(jsonPath)) {
      throw new Error(`Fabric profile JSON not found: ${jsonPath}`);
    }
    
    const fabricJson = JSON.parse(fs.readFileSync(jsonPath, 'utf8'));
    let modified = false;
    const base = 'https://maven.fabricmc.net/';
    
    fabricJson.arguments = fabricJson.arguments || {};
    fabricJson.arguments.game = fabricJson.arguments.game || [];
    fabricJson.arguments.jvm = fabricJson.arguments.jvm || [];
    
    // Complete set of authentication arguments that minecraft-launcher-core expects
    const requiredAuthArgs = [
      '--username', '${auth_player_name}',
      '--version', '${version_name}',
      '--gameDir', '${game_directory}',
      '--assetsDir', '${assets_root}',
      '--assetIndex', '${assets_index_name}',
      '--uuid', '${auth_uuid}',
      '--accessToken', '${auth_access_token}',
      '--userType', '${auth_user_type}',
      '--versionType', '${version_type}'
    ];
    
    // Check if authentication arguments are already present (look for the key placeholders)
    const gameArgsStr = JSON.stringify(fabricJson.arguments.game);
    const hasAuthArgs = ['${auth_player_name}', '${auth_uuid}', '${auth_access_token}', '${auth_user_type}'].every(arg => gameArgsStr.includes(arg));
    
    if (!hasAuthArgs) {
      // Only add if they're completely missing
      
      // Remove any existing partial auth args to prevent duplicates
      fabricJson.arguments.game = fabricJson.arguments.game.filter(arg => {
        if (typeof arg === 'string') {
          // Remove any existing auth-related arguments
          return !arg.includes('${auth_') && !['--username', '--uuid', '--accessToken', '--userType', '--version', '--gameDir', '--assetsDir', '--assetIndex', '--versionType'].includes(arg);
        }
        return true;
      });
      
      // Add the complete set at the beginning
      fabricJson.arguments.game = [...requiredAuthArgs, ...fabricJson.arguments.game];
      modified = true;
    } else if (gameArgsStr.includes('${auth_user_type}') && gameArgsStr.indexOf('${auth_user_type}') !== gameArgsStr.lastIndexOf('${auth_user_type}')) {
      const cleanedArgs = [];
      const seenArgs = new Set();
      
      for (let i = 0; i < fabricJson.arguments.game.length; i++) {
        const arg = fabricJson.arguments.game[i];
        if (typeof arg === 'string' && arg.includes('${auth_')) {
          if (!seenArgs.has(arg)) {
            cleanedArgs.push(arg);
            seenArgs.add(arg);
          }
        } else {
          cleanedArgs.push(arg);
        }
      }
      
      fabricJson.arguments.game = cleanedArgs;
      modified = true;
    }
    
    const hasAuthSession = fabricJson.arguments.jvm.some(arg => 
      typeof arg === 'string' && arg.includes('${auth_session}')
    );
    
    if (!hasAuthSession) {
      fabricJson.arguments.jvm.push('-Dauth.session=${auth_session}');
      modified = true;
    }
    
    for (const lib of fabricJson.libraries || []) {
      lib.downloads = lib.downloads || {};

      // 2.1 Ensure main artifact download metadata
      if (!lib.downloads.artifact && lib.name) {
        try {
          const [g, a, v] = lib.name.split(':');
          const jar = `${g.replace(/\./g,'/')}/${a}/${v}/${a}-${v}.jar`;
          lib.downloads.artifact = { 
            path: jar, 
            url: (lib.url || base) + jar 
          };
          modified = true;
        } catch { // _parseError unused, empty catch, removing try/catch (L1480)
        }
      }

      // 2.2 Ensure any native classifiers download metadata
      if (lib.natives && !lib.downloads.classifiers) {
        lib.downloads.classifiers = {};
        try {
          const [g, a, v] = lib.name.split(':');
          for (const classifier of Object.values(lib.natives)) {
            // e.g. 'windows' → 'artifact-version-natives-windows.jar'
            const jar = `${g.replace(/\./g,'/')}/${a}/${v}/${a}-${v}-${classifier}.jar`;
            lib.downloads.classifiers[classifier] = {
              path: jar,
              url: (lib.url || base) + jar
            };
          }
          modified = true;
        } catch { // _parseError unused, empty catch, removing try/catch (L1498)
        }
      }
    }
    
    if (modified) {
      fs.writeFileSync(jsonPath, JSON.stringify(fabricJson, null, 2));
    }
  }

  async downloadAssets(clientPath, minecraftVersion) {
    try {
      const versionJsonPath = path.join(clientPath, 'versions', minecraftVersion, `${minecraftVersion}.json`);
      if (!fs.existsSync(versionJsonPath)) {
        throw new Error(`Version JSON not found: ${versionJsonPath}`);
      }
      
      const versionJson = JSON.parse(fs.readFileSync(versionJsonPath, 'utf8'));
      if (!versionJson.assetIndex) {
        throw new Error(`Version JSON missing assetIndex: ${versionJsonPath}`);
      }
      
      const assetIndex = versionJson.assetIndex;
      const assetIndexUrl = assetIndex.url;
      const assetIndexId = assetIndex.id;
      
      
      const indexDir = path.join(clientPath, 'assets', 'indexes');
      const objectsDir = path.join(clientPath, 'assets', 'objects');
      
      fs.mkdirSync(indexDir, { recursive: true });
      fs.mkdirSync(objectsDir, { recursive: true });
      
      // Download asset index JSON
      const indexPath = path.join(indexDir, `${assetIndexId}.json`);
      
      await this.downloadFile(assetIndexUrl, indexPath);
      
      // Parse the asset index
      const indexJson = JSON.parse(fs.readFileSync(indexPath, 'utf8'));
      if (!indexJson.objects) {
        throw new Error(`Malformed asset index: no "objects" field in ${indexPath}`);
      }
      
      const totalAssets = Object.keys(indexJson.objects).length;

      // Send initial progress event
      this.emitter.emit('client-download-progress', {
        type: 'Assets',
        task: `Downloading game assets... 0/${totalAssets}`,
        total: totalAssets,
        current: 0
      });

      // Download each asset file
      let downloaded = 0;
      let skipped = 0;
      let processed = 0;
      const downloadPromises = [];

      const updateProgress = () => {
        this.emitter.emit('client-download-progress', {
          type: 'Assets',
          task: `Downloading game assets... ${processed}/${totalAssets}`,
          total: totalAssets,
          current: processed
        });
      };
      
      for (const meta of Object.values(indexJson.objects)) {
        const hash = meta.hash;
        const size = meta.size;
        const twoChar = hash.substring(0, 2);
        const destDir = path.join(objectsDir, twoChar);
        const destFile = path.join(destDir, hash);

        // Skip if file already exists and has correct size
        if (fs.existsSync(destFile)) {
          const stats = fs.statSync(destFile);
          if (stats.size === size) {
            skipped++;
            processed++;
            if (processed % 50 === 0 || processed === totalAssets) {
              updateProgress();
            }
            continue;
          }
        }

        // Ensure directory exists
        fs.mkdirSync(destDir, { recursive: true });

        // Download URL
        const downloadUrl = `https://resources.download.minecraft.net/${twoChar}/${hash}`;

        // Create download promise
        const downloadPromise = this.downloadFile(downloadUrl, destFile)
          .then(() => {
            downloaded++;
            processed++;
            if (processed % 50 === 0 || processed === totalAssets) {
              updateProgress();
            }
          })
          .catch(() => {
            processed++;
            if (processed % 50 === 0 || processed === totalAssets) {
              updateProgress();
            }
          });

        downloadPromises.push(downloadPromise);

        if (downloadPromises.length >= 50) {
          await Promise.all(downloadPromises);
          downloadPromises.length = 0;
        }
      }

      if (downloadPromises.length > 0) {
        await Promise.all(downloadPromises);
      }

      processed = totalAssets;
      updateProgress();
      
      return { success: true, downloaded, skipped, total: totalAssets };
      
    } catch (error) {
      return { success: false, error: error.message };
    }
  }
  /**
   * Clean up old Minecraft versions after successful download
   */
  async cleanupOldVersions(clientPath, currentVersion, currentFabricVersion = null) {
    try {
      const versionsDir = path.join(clientPath, 'versions');
      if (!fs.existsSync(versionsDir)) {
        return { success: true, message: 'No versions directory to clean up' };
      }

      const versionDirs = fs.readdirSync(versionsDir, { withFileTypes: true })
        .filter(dirent => dirent.isDirectory())
        .map(dirent => dirent.name);

      let cleanedVersions = [];
      let protectedVersions = [];

      for (const versionDir of versionDirs) {
        const shouldKeep = this.shouldKeepVersion(versionDir, currentVersion, currentFabricVersion);
        
        if (shouldKeep.keep) {
          protectedVersions.push(versionDir);
          continue;
        }

        // Remove old version directory
        const versionPath = path.join(versionsDir, versionDir);
        try {
          fs.rmSync(versionPath, { recursive: true, force: true });
          cleanedVersions.push(versionDir);
          console.log(`🗑️ Cleaned up old version: ${versionDir}`);
        } catch (error) {
          console.error(`❌ Failed to remove ${versionDir}:`, error.message);
        }
      }

      this.emitter.emit('client-download-progress', {
        type: 'Cleanup',
        task: `🗑️ Cleaned up ${cleanedVersions.length} old versions`,
        total: 100,
        current: 100
      });

      return {
        success: true,
        message: `Cleaned up ${cleanedVersions.length} old versions`,
        cleanedVersions,
        protectedVersions
      };

    } catch (error) {
      console.error('❌ Cleanup failed:', error);
      return {
        success: false,
        error: error.message
      };
    }
  }
  /**
   * Determine if a version should be kept or cleaned up
   */
  shouldKeepVersion(versionDir, currentVersion, currentFabricVersion) {
    // Only keep the current vanilla version
    if (versionDir === currentVersion) {
      return { keep: true, reason: 'Current vanilla version' };
    }

    // Only keep the current Fabric version
    if (currentFabricVersion && versionDir === currentFabricVersion) {
      return { keep: true, reason: 'Current Fabric version' };
    }

    // Remove everything else - no exceptions
    return { keep: false, reason: 'Old version - cleaning up' };
  }

  /**
   * Check if the server version has changed since the last client check
   */
  async _checkForVersionChange(clientPath, requiredVersion) {
    try {
      const lastVersionFile = path.join(clientPath, '.last-server-version');
      
      if (!fs.existsSync(lastVersionFile)) {
        // First time check - save the version and no cleanup needed
        fs.writeFileSync(lastVersionFile, requiredVersion, 'utf8');
        return false;
      }
      
      const lastVersion = fs.readFileSync(lastVersionFile, 'utf8').trim();
      
      if (lastVersion !== requiredVersion) {
        // Version changed - update the file
        fs.writeFileSync(lastVersionFile, requiredVersion, 'utf8');
        console.log(`🔄 Server version changed: ${lastVersion} → ${requiredVersion}`);
        return true;
      }
      
      return false;
    } catch (error) {
      console.error('Failed to check version change:', error);
      return false;
    }
  }

  /**
   * Clean up old versions when server version changes
   */
  async _cleanupOldVersionsOnChange(clientPath, currentVersion) {
    try {
      const versionsDir = path.join(clientPath, 'versions');
      if (!fs.existsSync(versionsDir)) {
        return { success: true, message: 'No versions directory to clean up' };
      }

      const versionDirs = fs.readdirSync(versionsDir, { withFileTypes: true })
        .filter(dirent => dirent.isDirectory())
        .map(dirent => dirent.name);

      let cleanedVersions = [];

      for (const versionDir of versionDirs) {
        // Keep only the current version - remove all others
        if (versionDir === currentVersion) {
          continue; // Keep current vanilla version
        }
        
        // For Fabric profiles, keep only those matching the current version
        if (versionDir.startsWith('fabric-loader-') && versionDir.endsWith(`-${currentVersion}`)) {
          continue; // Keep current Fabric profile
        }

        // Remove everything else
        const versionPath = path.join(versionsDir, versionDir);
        try {
          fs.rmSync(versionPath, { recursive: true, force: true });
          cleanedVersions.push(versionDir);
          console.log(`🗑️ Cleaned up old version: ${versionDir}`);
        } catch (error) {
          console.error(`❌ Failed to remove ${versionDir}:`, error.message);
        }
      }

      console.log(`🔄 Version change cleanup: removed ${cleanedVersions.length} old versions`);

      return {
        success: true,
        message: `Cleaned up ${cleanedVersions.length} old versions due to version change`,
        cleanedVersions
      };

    } catch (error) {
      console.error('❌ Version change cleanup failed:', error);
      return {
        success: false,
        error: error.message
      };
    }
  }

  // Clear Minecraft client files for re-download
  async clearMinecraftClient(clientPath, minecraftVersion) {
    try {
      const versionsDir = path.join(clientPath, 'versions');
      
      // Remove specific version directory
      if (minecraftVersion) {
        const versionDir = path.join(versionsDir, minecraftVersion);
        if (fs.existsSync(versionDir)) {
          fs.rmSync(versionDir, { recursive: true, force: true });
        }
        
        // Also remove Fabric profiles for this version
        const fabricProfileName = `fabric-loader-${minecraftVersion}`;
        const fabricDir = path.join(versionsDir, fabricProfileName);
        if (fs.existsSync(fabricDir)) {
          fs.rmSync(fabricDir, { recursive: true, force: true });
        }
      }
      
      return { success: true, message: `Cleared client files for ${minecraftVersion}` };
    } catch (error) {
      return { success: false, error: error.message };
    }
  }

  // Clear assets directory
  async clearAssets(clientPath) {
    try {
      const assetsDir = path.join(clientPath, 'assets');
      if (fs.existsSync(assetsDir)) {
        fs.rmSync(assetsDir, { recursive: true, force: true });
      }
      return { success: true, message: 'Cleared assets directory' };
    } catch (error) {
      return { success: false, error: error.message };
    }
  }

  // Fix Fabric profile asset index
  async fixFabricAssetIndex(clientPath, fabricProfileName, vanillaVersion) {
    try {
      const versionsDir = path.join(clientPath, 'versions');
      const fabricJsonPath = path.join(versionsDir, fabricProfileName, `${fabricProfileName}.json`);
      const vanillaJsonPath = path.join(versionsDir, vanillaVersion, `${vanillaVersion}.json`);
      
      if (!fs.existsSync(fabricJsonPath)) {
        return { success: false, error: `Fabric profile not found: ${fabricProfileName}` };
      }
      
      if (!fs.existsSync(vanillaJsonPath)) {
        return { success: false, error: `Vanilla profile not found: ${vanillaVersion}` };
      }
      
      const fabricJson = JSON.parse(fs.readFileSync(fabricJsonPath, 'utf8'));
      const vanillaJson = JSON.parse(fs.readFileSync(vanillaJsonPath, 'utf8'));
      
      let modified = false;
      
      // Fix asset index
      if (vanillaJson.assetIndex && (!fabricJson.assetIndex || fabricJson.assetIndex.id !== vanillaJson.assetIndex.id)) {
        fabricJson.assetIndex = vanillaJson.assetIndex;
        modified = true;
      }
      
      // Fix downloads.assets
      if (vanillaJson.downloads?.assets && !fabricJson.downloads?.assets) {
        fabricJson.downloads = fabricJson.downloads || {};
        fabricJson.downloads.assets = vanillaJson.downloads.assets;
        modified = true;
      }
      
      if (modified) {
        fs.writeFileSync(fabricJsonPath, JSON.stringify(fabricJson, null, 2));
        return { success: true, message: 'Fixed Fabric asset index' };
      }
      
      return { success: true, message: 'Asset index already correct' };
    } catch (error) {
      return { success: false, error: error.message };
    }
  }

  // ...existing code...
}

module.exports = { ClientDownloader };
